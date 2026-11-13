// <copyright file="CSharpToGSharpTranslator.Deconstruction.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private let recordDeconstructionAdapterNames Dictionary[IMethodSymbol, string] =
        Dictionary[IMethodSymbol, string](SymbolEqualityComparer.Default)
        private let recordScopedLocalOrdinals Dictionary[(Site SyntaxNode, Stem string), int32] =
        Dictionary[(Site SyntaxNode, Stem string), int32]()
        private let recordPatternCaches Dictionary[
            SyntaxNode,
            List[(Path string, Method IMethodSymbol, Flag string, Values string, Type GTypeReference)]
        ] = Dictionary[
            SyntaxNode,
            List[(Path string, Method IMethodSymbol, Flag string, Values string, Type GTypeReference)]
        ]()
        private let recordPatternReceiverCaches Dictionary[
            SyntaxNode,
            List[(Path string, Flag string, Value string, Type GTypeReference)]
        ] = Dictionary[SyntaxNode, List[(Path string, Flag string, Value string, Type GTypeReference)]]()
        private let recordPatternTypeGuards Dictionary[
            SyntaxNode,
            List[(Path string, Type ITypeSymbol, Flag string, Value string?, StorageType GTypeReference?)]
        ] = Dictionary[
            SyntaxNode,
            List[(Path string, Type ITypeSymbol, Flag string, Value string?, StorageType GTypeReference?)]
        ]()
        private let importedProtectedDeconstructHookNames Dictionary[IMethodSymbol, string] = Dictionary[
            IMethodSymbol,
            string
        ](SymbolEqualityComparer.Default)
        private let importedBaseDeconstructHelperNames Dictionary[IMethodSymbol, string] = Dictionary[
            IMethodSymbol,
            string
        ](SymbolEqualityComparer.Default)
        private let valueTypeExplicitDeconstructHelperNames Dictionary[IMethodSymbol, string] = Dictionary[
            IMethodSymbol,
            string
        ](SymbolEqualityComparer.Default)
        private let pendingNestedBridges Dictionary[SyntaxNode, GMember] = Dictionary[SyntaxNode, GMember]()

        private func RecordDeconstructionAdapterName(method IMethodSymbol) string {
            if this.TryResolveMigratedProducerDeconstruct(method, out var sourceMethod, out var producerCompilation) {
                return this.RecordDeconstructionAdapterName(sourceMethod!!, producerCompilation!!)
            }
            return this.RecordDeconstructionAdapterName(method, this.context.Compilation)
        }

        private func IsSecondarySameTypeContractOverload(
            method IMethodSymbol,
            contractMembers IReadOnlyCollection[IMethodSymbol]
        ) bool {
            let original = method.OriginalDefinition
            return original.ExplicitInterfaceImplementations.IsDefaultOrEmpty && contractMembers.Any(
                (candidate IMethodSymbol) -> candidate
                    .ExplicitInterfaceImplementations
                    .IsDefaultOrEmpty &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(candidate.ContainingType, original.ContainingType) && string.CompareOrdinal(
                    candidate.ToDisplayString(),
                    original.ToDisplayString()
                ) < 0
            )
        }

        private func RecordDeconstructionAdapterName(method IMethodSymbol, compilation Compilation) string {
            var original = (
                (method.ReducedFrom ?? method).PartialDefinitionPart ?? (method.ReducedFrom ?? method)
            ).OriginalDefinition
            let allocator = EmittedNameAllocator.For(compilation)
            let contractMembers = allocator.GetDeconstructContractMembers(original)
            let isSecondaryOverload = this.IsSecondarySameTypeContractOverload(original, contractMembers)
            let primaryContractMembers = contractMembers.Where(
                (candidate IMethodSymbol) -> !this.IsSecondarySameTypeContractOverload(candidate, contractMembers)
            )
                .ToArray()
            if primaryContractMembers.Length > 1 && !isSecondaryOverload {
                original = primaryContractMembers.OrderBy(
                    (candidate IMethodSymbol) -> candidate.ToDisplayString(),
                    StringComparer.Ordinal
                )
                    .First()
            }
            if this.recordDeconstructionAdapterNames.TryGetValue(original, out var existing) {
                return existing
            }
            var ordinal = original
                .ContainingType
                .GetMembers("Deconstruct")
                .OfType[IMethodSymbol]()
                .OrderBy((candidate IMethodSymbol) -> candidate.ToDisplayString(), StringComparer.Ordinal)
                .TakeWhile((candidate IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(candidate, original))
                .Count()
            let allContractMembers = allocator.GetAllDeconstructContractMembers(original)
            let owners = if allContractMembers.Count > 1 {
                allContractMembers
                    .SelectMany((member IMethodSymbol) -> ReceiverTypeHierarchy(member.ContainingType))
                    .Distinct[INamedTypeSymbol](SymbolEqualityComparer.Default)
                    .ToList()
            } else {
                ReceiverTypeHierarchy(original.ContainingType).ToList()
            }
            let hierarchy = ReceiverTypeHierarchy(original.ContainingType).ToList()
            let taken = HashSet[string](
                owners.SelectMany((owner INamedTypeSymbol) -> owner.GetMembers()).Select(
                    (member ISymbol) -> allocator.GetName(member)!!
                ),
                StringComparer.Ordinal
            )
            taken.UnionWith(allocator.GetDeconstructionReservedNames(original))
            for ancestor in hierarchy.Skip(1) {
                for inherited in ancestor.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                    if SymbolEqualityComparer.Default.Equals(inherited.OriginalDefinition, original) ||
                        contractMembers.Contains(inherited.OriginalDefinition) {
                        continue
                    }
                    if EmittedNameAllocator.IsUserRecordDeconstruct(inherited) ||
                        allocator
                        .HasRenamedDeconstructContract(inherited) {
                        taken.Add(this.RecordDeconstructionAdapterName(inherited, compilation))
                    }
                }
            }
            let outputCount = if original.IsExtensionMethod {
                original.Parameters.Length - 1
            } else {
                original.Parameters.Length
            }
            let stem = if outputCount == 1 {
                "deconstructValue"
            } else {
                "deconstructTuple"
            }
            var name = stem
            for var suffix = 2; taken.Contains(name) || ordinal > 0; suffix++ {
                if !taken.Contains(name) {
                    ordinal--
                }
                name = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            var helperSuffix = 2
            var assignedName = name
            let membersToReserve = if !isSecondaryOverload && primaryContractMembers.Length > 0 {
                cast[IReadOnlyCollection[IMethodSymbol]](primaryContractMembers)
            } else {
                cast[IReadOnlyCollection[IMethodSymbol]]([]IMethodSymbol{original})
            }
            while !LiftedLocalFunctionNameAllocator.For(compilation).TryReserveContractMemberNames(
                membersToReserve,
                name,
                out assignedName
            ) {
                do {
                    name = stem + helperSuffix.ToString(CultureInfo.InvariantCulture)
                    helperSuffix++
                } while taken.Contains(name)
            }
            for member in membersToReserve {
                this.recordDeconstructionAdapterNames[member] = assignedName
            }
            this.recordDeconstructionAdapterNames[original] = assignedName
            return assignedName
        }

        private func AllocateRecordScopedLocalName(stem string, site SyntaxNode) string {
            let key = (site, stem)
            this.recordScopedLocalOrdinals.TryGetValue(key, out var ordinal)
            this.recordScopedLocalOrdinals[key] = ordinal + 1
            let name = LiftedLocalFunctionNameAllocator.For(this.context.Compilation).GetOrAllocateScopedLocalName(
                site,
                ordinal,
                stem,
                () -> this.AllocateSynthesizedLocalName(stem, site)
            )
            let body = this.state.CurrentBodyScope ?? site.SyntaxTree.GetRoot()
            if this.state.SynthesizedLocalOccupiedNamesByBody.TryGetValue(body, out var occupied) {
                occupied.Add(name)
            }
            return name
        }

        private func BeginRecordPatternDecision(owner SyntaxNode) {
            this.recordPatternCaches.Remove(owner)
            this.recordPatternReceiverCaches.Remove(owner)
            this.recordPatternTypeGuards.Remove(owner)
        }

        private func OwnerHasMixedRecordPositionalAndPropertyPatterns(owner SyntaxNode) bool {
            let allPatterns = owner
                .DescendantNodes()
                .OfType[RecursivePatternSyntax]()
                .Where(
                (pattern RecursivePatternSyntax) -> object.ReferenceEquals(
                    this.RecordPatternDecisionOwner(pattern),
                    owner
                )
            )
                .ToArray()
            let rootPatterns = allPatterns.Where(
                (pattern RecursivePatternSyntax) -> this.RecordPatternDecisionPath(pattern, owner).Length == 0
            )
                .ToArray()
            return rootPatterns.Any((pattern RecursivePatternSyntax) -> pattern.PropertyPatternClause != nil) &&
                allPatterns
                .Any(
                (pattern RecursivePatternSyntax) ->
                this.UserRecordPatternDeconstruct(pattern) != nil && this.RecordPatternNeedsDeconstruction(pattern)
            )
        }

        private func EffectiveRootRecursivePatternType(
            pattern RecursivePatternSyntax,
            receiverType ITypeSymbol?
        ) ITypeSymbol? {
            let explicitType = if pattern.Type != nil {
                this.context.GetTypeInfo(pattern.Type).Type
            } else {
                default(ITypeSymbol?)
            }
            let rawType = explicitType ?? receiverType ?? this.UserRecordPatternDeconstruct(pattern)?.ContainingType
            if rawType == nil {
                return nil
            }
            let unwrappedRaw = UnwrapNullablePatternType(rawType)
            if receiverType != nil {
                let unwrappedReceiver = UnwrapNullablePatternType(receiverType)
                if unwrappedReceiver is INamedTypeSymbol receiverNamed &&
                    unwrappedRaw is INamedTypeSymbol rawNamed &&
                    ReceiverTypeHierarchy(receiverNamed).Contains(rawNamed, SymbolEqualityComparer.Default) {
                    return unwrappedReceiver
                }
            }
            return unwrappedRaw
        }

        private func GetOrCreateRecordPatternTypeGuard(
            owner SyntaxNode,
            path string,
            matchedType ITypeSymbol,
            requiresConversion bool,
            site RecursivePatternSyntax,
            declarations List[GStatement]?
        )(Flag string, Value string?) {
            let unwrapped = UnwrapNullablePatternType(matchedType)
            if !this.recordPatternTypeGuards.TryGetValue(owner, out var guards) {
                guards = List[
                    (Path string, Type ITypeSymbol, Flag string, Value string?, StorageType GTypeReference?)
                ]()
                this.recordPatternTypeGuards.Add(owner, guards)
            }
            for var i = 0; i < guards.Count; i++ {
                let entry = guards[i]
                if entry.Path == path && SymbolEqualityComparer.Default.Equals(entry.Type, unwrapped) {
                    if requiresConversion && entry.Value == nil {
                        let value = this.AllocateRecordScopedLocalName("matchedValue", site)
                        var storageType = this.typeMapper.Map(unwrapped, this.context, site.GetLocation())
                        if unwrapped.IsReferenceType {
                            storageType = MakeNullable(storageType)
                        }
                        guards[i] = (entry.Path, entry.Type, entry.Flag, value, storageType)
                        if owner is IsPatternExpressionSyntax && declarations != nil {
                            declarations.Add(LocalDeclarationStatement(BindingKind.Var, value, storageType))
                        }
                        return (entry.Flag, value)
                    }
                    return (entry.Flag, entry.Value)
                }
            }
            let flag = this.AllocateRecordScopedLocalName("matchedType", site)
            var value string? = nil
            var storageType GTypeReference? = nil
            if requiresConversion {
                value = this.AllocateRecordScopedLocalName("matchedValue", site)
                storageType = this.typeMapper.Map(unwrapped, this.context, site.GetLocation())
                if unwrapped.IsReferenceType {
                    storageType = MakeNullable(storageType)
                }
            }
            guards.Add((path, unwrapped, flag, value, storageType))
            if owner is IsPatternExpressionSyntax && declarations != nil {
                declarations.Add(
                    LocalDeclarationStatement(
                        BindingKind.Var,
                        flag,
                        NamedTypeReference("bool"),
                        LiteralExpression.Bool(false)
                    )
                )
                if value != nil {
                    declarations.Add(LocalDeclarationStatement(BindingKind.Var, value, storageType))
                }
            }
            return (flag, value)
        }

        private func TryGetSharedRecordPatternTypeGuard(
            recursive RecursivePatternSyntax,
            receiver GExpression?,
            receiverType ITypeSymbol?,
            currentTest GExpression?,
            out guardedTest GExpression?,
            out guardedMemberReceiver GExpression?
        ) bool {
            guardedTest = currentTest
            guardedMemberReceiver = receiver
            let owner = this.RecordPatternDecisionOwner(recursive)
            if owner is not IsPatternExpressionSyntax ||
                currentTest == nil ||
                !this.OwnerHasMixedRecordPositionalAndPropertyPatterns(owner) {
                return false
            }
            let path = this.RecordPatternDecisionPath(recursive, owner)
            if path.Length != 0 {
                return false
            }
            let matchedType = this.EffectiveRootRecursivePatternType(recursive, receiverType)
            if matchedType == nil {
                return false
            }
            let rootCandidates = owner
                .DescendantNodes()
                .OfType[RecursivePatternSyntax]()
                .Where(
                (candidate RecursivePatternSyntax) -> object.ReferenceEquals(
                    this.RecordPatternDecisionOwner(candidate),
                    owner
                ) &&
                    this.RecordPatternDecisionPath(candidate, owner) == path && SymbolEqualityComparer.Default.Equals(
                    this.EffectiveRootRecursivePatternType(candidate, receiverType),
                    matchedType
                )
            )
                .OrderBy((candidate RecursivePatternSyntax) -> candidate.SpanStart)
                .ToArray()
            if rootCandidates.Length == 0 ||
                (
                rootCandidates.Length == 1 &&
                    (recursive.PositionalPatternClause == nil || recursive.PropertyPatternClause == nil)
            ) {
                return false
            }
            let declarations = this.state.ShortCircuitSpillDeclarations ?? this.state.PendingSpillPrologue
            if declarations == nil {
                return false
            }
            let requiresConversion = receiverType == nil ||
                IsNullableValueType(receiverType) ||
                !SymbolEqualityComparer
                .Default
                .Equals(UnwrapNullablePatternType(receiverType), matchedType)
            let (guardFlag, guardValue) = this.GetOrCreateRecordPatternTypeGuard(
                owner,
                path,
                matchedType,
                requiresConversion,
                rootCandidates[0],
                declarations
            )
            let flagExpr = IdentifierExpression(guardFlag)
            let assignStatements = List[GStatement]()
            if guardValue != nil && receiver != nil {
                let capturedValue = if recursive.Type != nil &&
                    !IsNullableValueType(receiverType) &&
                    (
                    receiverType == nil || !SymbolEqualityComparer.Default.Equals(
                        UnwrapNullablePatternType(receiverType),
                        matchedType
                    )
                ) {
                    this.BuildPatternNarrowingReplacement(receiver, receiverSyntax: nil, recursive.Type, receiverType)
                } else {
                    EnsureNonNullAssertion(receiver)
                }
                assignStatements.Add(AssignmentStatement(IdentifierExpression(guardValue), capturedValue))
            }
            assignStatements.Add(AssignmentStatement(flagExpr, LiteralExpression.Bool(true)))
            guardedTest = ParenthesizedExpression(
                BinaryExpression(
                    flagExpr,
                    "||",
                    BlockExpression([]GStatement{IfStatement(currentTest, BlockStatement(assignStatements))}, flagExpr)
                )
            )
            if receiver != nil {
                if guardValue != nil {
                    let valueExpr = IdentifierExpression(guardValue)
                    guardedMemberReceiver = if matchedType.IsReferenceType {
                        EnsureNonNullAssertion(valueExpr)
                    } else {
                        valueExpr
                    }
                    if recursive.Designation is SingleVariableDesignationSyntax recVar &&
                        this
                        .context
                        .GetDeclaredSymbol(recVar) is {} recBound {
                        this.state.PatternBindings[recBound] = guardedMemberReceiver!!
                    }
                } else if this.IsGSharpNullablePatternReceiver(receiver) ||
                    receiverType?.NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    IsNullableValueType(receiverType) {
                    guardedMemberReceiver = EnsureNonNullAssertion(receiver)
                }
            }
            return true
        }

        private func UnwrapNullablePatternType(type ITypeSymbol) ITypeSymbol {
            if type is INamedTypeSymbol{
                OriginalDefinition: {SpecialType: SpecialType.System_Nullable_T},
                TypeArguments: {Length: 1}
            } nullableValue {
                return nullableValue.TypeArguments[0]
            }
            return type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated)
        }

        private func BuildRecordDeconstructionAdapter(
            method IMethodSymbol,
            forceConcreteImplementation bool = false,
            ownerIsUnsafe bool = false,
            explicitInterfaceOverride GTypeReference? = nil
        ) MethodDeclaration? {
            if method.IsExtensionMethod {
                return this.BuildExtensionRecordDeconstructionAdapter(method)
            }
            // A method adapter adds no equality storage or printable property to the data type.
            if (
                !this.nameAllocator.HasRenamedDeconstructContract(method) &&
                    !this.TryResolveMigratedProducerDeconstruct(method, out _, out _)
            ) ||
                method.IsStatic ||
                !method.ReturnsVoid ||
                method.Arity != 0 ||
                method.IsPartialDefinition ||
                (
                method.IsOverride &&
                    method.OverriddenMethod != nil &&
                    (
                    this.nameAllocator.HasRenamedDeconstructContract(method.OverriddenMethod) ||
                        this.TryResolveMigratedProducerDeconstruct(method.OverriddenMethod, out _, out _)
                ) &&
                    (
                    !method.OverriddenMethod!!
                        .DeclaringSyntaxReferences
                        .IsDefaultOrEmpty ||
                        this.TryResolveMigratedProducerDeconstruct(method.OverriddenMethod, out _, out _)
                )
            ) ||
                method
                .Parameters
                .Length < 1 ||
                method
                .Parameters
                .Any((parameter IParameterSymbol) -> parameter.RefKind != RefKind.Out) {
                return nil
            }
            if !method.ExplicitInterfaceImplementations.IsDefaultOrEmpty {
                let explicitSlot = method.ExplicitInterfaceImplementations[0]
                if explicitSlot
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty &&
                    !this.TryResolveMigratedProducerDeconstruct(explicitSlot, out _, out _) {
                    return nil
                }
            }
            for var i = 0; i < method.Parameters.Length; i++ {
                if method.Parameters[i].Type.IsRefLikeType {
                    if !method.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                        this.context.ReportUnsupported(
                            method.DeclaringSyntaxReferences[0].GetSyntax(),
                            "record Deconstruct outputs with ref-like types cannot use a tuple adapter."
                        )
                    }
                    return nil
                }
            }
            let types = this.MapRecordDeconstructionParameterTypes(method)
            let resultType = this.RecordDeconstructionResultType(method, types)
            if !forceConcreteImplementation &&
                method
                .ContainingType
                .TypeKind == TypeKind.Interface &&
                method
                .IsAbstract {
                return MethodDeclaration(
                    this.RecordDeconstructionAdapterName(method),
                    Array.Empty[Parameter](),
                    resultType,
                    body: nil,
                    visibility: Visibility.Default
                )
            }
            let syntaxNode = method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            let explicitInterfaceType GTypeReference? = if explicitInterfaceOverride != nil {
                explicitInterfaceOverride
            } else if !forceConcreteImplementation && !method.ExplicitInterfaceImplementations.IsDefaultOrEmpty {
                this.typeMapper.Map(
                    method.ExplicitInterfaceImplementations[0].ContainingType,
                    this.context,
                    syntaxNode?.GetLocation()
                )
            } else {
                default(GTypeReference?)
            }
            let occupied = HashSet[string](StringComparer.Ordinal)
            for typeParameter in method.ContainingType.TypeParameters {
                occupied.Add(this.EmittedName(typeParameter, typeParameter.Name)!!)
            }
            let statements = List[GStatement]()
            let arguments = List[GExpression]()
            let elements = List[GExpression]()
            var receiver GExpression = ThisExpression()
            if method.ContainingType.IsValueType && explicitInterfaceType == nil {
                // C# deconstruction calls a struct receiver copy; an explicit Deconstruct call can mutate the original.
                var receiverName = "receiver"
                for var suffix = 2; occupied.Contains(receiverName); suffix++ {
                    receiverName = "receiver_" + suffix.ToString(CultureInfo.InvariantCulture)
                }
                occupied.Add(receiverName)
                statements.Add(LocalDeclarationStatement(BindingKind.Var, receiverName, initializer: receiver))
                receiver = IdentifierExpression(receiverName)
            }
            if !forceConcreteImplementation && explicitInterfaceType != nil && !method.ContainingType.IsValueType {
                receiver = ParenthesizedExpression(
                    ConversionExpression(explicitInterfaceType, receiver, isCheckedReferenceCast: true)
                )
            }
            for var i = 0; i < method.Parameters.Length; i++ {
                let parameter = method.Parameters[i]
                let type = types[i]
                let stem = "component" + i.ToString(CultureInfo.InvariantCulture)
                var name = stem
                for var suffix = 2; occupied.Contains(name); suffix++ {
                    name = stem + "_" + suffix.ToString(CultureInfo.InvariantCulture)
                }
                occupied.Add(name)
                let element = IdentifierExpression(name)
                statements.Add(LocalDeclarationStatement(BindingKind.Var, name, type))
                arguments.Add(OutArgumentExpression("out", name))
                elements.Add(
                    if method.Parameters.Length > 1 && IsPointerOrFunctionPointerType(parameter.Type) {
                        cast[GExpression](
                            ConversionExpression(NamedTypeReference("nuint"), element, isCheckedReferenceCast: true)
                        )
                    } else {
                        cast[GExpression](element)
                    }
                )
            }
            let targetMethodName = if !forceConcreteImplementation && this.NeedsValueTypeExplicitDeconstructHelper(
                method
            ) {
                this.ValueTypeExplicitDeconstructHelperName(method)
            } else {
                this.EmittedName(method, method.Name)
            }
            statements.Add(
                ExpressionStatement(InvocationExpression(MemberAccessExpression(receiver, targetMethodName), arguments))
            )
            statements.Add(
                ReturnStatement(
                    if elements.Count == 1 {
                        elements[0]
                    } else {
                        TupleLiteralExpression(elements)
                    }
                )
            )
            return MethodDeclaration(
                this.RecordDeconstructionAdapterName(method),
                Array.Empty[Parameter](),
                resultType,
                BlockStatement(statements),
                visibility: if explicitInterfaceType != nil || method.ContainingType.TypeKind == TypeKind.Interface {
                    Visibility.Default
                } else if forceConcreteImplementation {
                    Visibility.Public
                } else {
                    MapVisibility(method, this.context, syntaxNode)
                },
                explicitInterfaceType: explicitInterfaceType
            )
        }

        private func BuildConstructedInterfaceDeconstructionAdapters(method IMethodSymbol) IEnumerable[
            MethodDeclaration
        ] {
            let results = List[MethodDeclaration]()
            if method.IsExtensionMethod ||
                method.IsStatic ||
                !method.ReturnsVoid ||
                method.Arity != 0 ||
                method.IsPartialDefinition ||
                !method
                .ExplicitInterfaceImplementations
                .IsDefaultOrEmpty ||
                method
                .ContainingType
                .TypeKind == TypeKind.Interface ||
                this.BuildRecordDeconstructionAdapter(method) == nil {
                return results
            }
            let syntaxNode = method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            let types = this.MapRecordDeconstructionParameterTypes(method)
            let resultType = this.RecordDeconstructionResultType(method, types)
            let methodAdapterName = this.RecordDeconstructionAdapterName(method)
            let seenKeys = HashSet[string](StringComparer.Ordinal)
            for iface in method.ContainingType.AllInterfaces {
                for slot in iface.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                    if !this.nameAllocator.HasRenamedDeconstructContract(slot) &&
                        !this.TryResolveMigratedProducerDeconstruct(slot, out _, out _) {
                        continue
                    }
                    if !SymbolEqualityComparer.Default.Equals(
                        method.ContainingType.FindImplementationForInterfaceMember(slot),
                        method
                    ) {
                        continue
                    }
                    let slotAdapterName = this.RecordDeconstructionAdapterName(slot)
                    if slotAdapterName == methodAdapterName && !method.ContainingType.IsValueType {
                        continue
                    }
                    let mappedIface = this.typeMapper.Map(iface, this.context, syntaxNode?.GetLocation())
                    if mappedIface == nil {
                        continue
                    }
                    let key = GSharpPrinter.RenderTypeReference(mappedIface) + ":" + slotAdapterName
                    if !seenKeys.Add(key) {
                        continue
                    }
                    let occupied = HashSet[string](StringComparer.Ordinal)
                    for typeParameter in method.ContainingType.TypeParameters {
                        occupied.Add(this.EmittedName(typeParameter, typeParameter.Name)!!)
                    }
                    let statements = List[GStatement]()
                    let arguments = List[GExpression]()
                    let elements = List[GExpression]()
                    for var i = 0; i < method.Parameters.Length; i++ {
                        let parameter = method.Parameters[i]
                        let type = types[i]
                        let stem = "component" + i.ToString(CultureInfo.InvariantCulture)
                        var name = stem
                        for var suffix = 2; occupied.Contains(name); suffix++ {
                            name = stem + "_" + suffix.ToString(CultureInfo.InvariantCulture)
                        }
                        occupied.Add(name)
                        let element = IdentifierExpression(name)
                        statements.Add(LocalDeclarationStatement(BindingKind.Var, name, type))
                        arguments.Add(OutArgumentExpression("out", name))
                        elements.Add(
                            if method.Parameters.Length > 1 && IsPointerOrFunctionPointerType(parameter.Type) {
                                cast[GExpression](
                                    ConversionExpression(
                                        NamedTypeReference("nuint"),
                                        element,
                                        isCheckedReferenceCast: true
                                    )
                                )
                            } else {
                                cast[GExpression](element)
                            }
                        )
                    }
                    statements.Add(
                        ExpressionStatement(
                            InvocationExpression(
                                MemberAccessExpression(ThisExpression(), this.EmittedName(method, method.Name)),
                                arguments
                            )
                        )
                    )
                    statements.Add(
                        ReturnStatement(
                            if elements.Count == 1 {
                                elements[0]
                            } else {
                                TupleLiteralExpression(elements)
                            }
                        )
                    )
                    results.Add(
                        MethodDeclaration(
                            slotAdapterName,
                            Array.Empty[Parameter](),
                            resultType,
                            BlockStatement(statements),
                            visibility: Visibility.Default,
                            explicitInterfaceType: mappedIface
                        )
                    )
                }
            }
            return results
        }

        private func BuildExtensionRecordDeconstructionAdapter(method IMethodSymbol) MethodDeclaration? {
            if !method.IsExtensionMethod ||
                method.Name != "Deconstruct" ||
                !method.ReturnsVoid ||
                method.IsPartialDefinition ||
                method
                .Parameters
                .Length < 2 ||
                method
                .Parameters
                .Skip(1)
                .Any(
                (parameter IParameterSymbol) -> parameter.RefKind != RefKind.Out || parameter.Type.IsRefLikeType
            ) ||
                !this.ExtensionReceiverCanBeRecord(method.Parameters[0].Type) {
                return nil
            }
            let signature = method.PartialImplementationPart ?? method
            let syntax = signature.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as MethodDeclarationSyntax
            var parameters = this.MapParameters(signature, syntax?.ParameterList, skipFirst: false)
            if signature.PartialDefinitionPart != nil {
                parameters = this.ReconcilePartialMethodParameters(signature, parameters, isDeclaringPart: false)
            }
            let holderName = this.EmittedName(signature.ContainingType, signature.ContainingType.Name)!!
            let targetMethodName = this.EmittedName(signature, signature.Name)!!
            let adapterName = this.RecordDeconstructionAdapterName(method)
            let occupied = HashSet[string](StringComparer.Ordinal){holderName, targetMethodName, adapterName}
            for typeParameter in signature.TypeParameters {
                occupied.Add(this.EmittedName(typeParameter, typeParameter.Name)!!)
            }
            var receiverParameter = parameters[0]
            if occupied.Contains(receiverParameter.Name) {
                let receiverStem = receiverParameter.Name.TrimStart('$')
                var renamedReceiver = receiverStem + "_2"
                for var suffix = 3; occupied.Contains(renamedReceiver); suffix++ {
                    renamedReceiver = receiverStem + "_" + suffix.ToString(CultureInfo.InvariantCulture)
                }
                receiverParameter = Parameter(
                    renamedReceiver,
                    receiverParameter.Type,
                    receiverParameter.IsVariadic,
                    receiverParameter.RefKind,
                    receiverParameter.DefaultValue,
                    receiverParameter.Attributes
                )
            }
            occupied.Add(receiverParameter.Name)
            let outputTypes = parameters.Skip(1).Select((parameter Parameter) -> parameter.Type).ToList()
            let outputParameters = signature.Parameters.Skip(1).ToList()
            let statements = List[GStatement]()
            let arguments = List[GExpression]{
                PassStaticExtensionHelperReceiver(IdentifierExpression(receiverParameter.Name), signature)!!
            }
            let elements = List[GExpression]()
            for var i = 0; i < outputParameters.Count; i++ {
                let stem = "component" + i.ToString(CultureInfo.InvariantCulture)
                var name = stem
                for var suffix = 2; occupied.Contains(name); suffix++ {
                    name = stem + "_" + suffix.ToString(CultureInfo.InvariantCulture)
                }
                occupied.Add(name)
                let element = IdentifierExpression(name)
                statements.Add(LocalDeclarationStatement(BindingKind.Var, name, outputTypes[i]))
                arguments.Add(OutArgumentExpression("out", name))
                elements.Add(
                    if outputParameters.Count > 1 && IsPointerOrFunctionPointerType(outputParameters[i].Type) {
                        cast[GExpression](
                            ConversionExpression(NamedTypeReference("nuint"), element, isCheckedReferenceCast: true)
                        )
                    } else {
                        cast[GExpression](element)
                    }
                )
            }
            let typeParameters = this.MapMethodTypeParameters(signature, signature.PartialDefinitionPart)
            let typeArguments = signature
                .TypeParameters
                .Select(
                (parameter ITypeParameterSymbol) -> cast[GTypeReference](
                    NamedTypeReference(this.EmittedName(parameter, parameter.Name))
                )
            )
                .ToList()
            statements.Add(
                ExpressionStatement(
                    InvocationExpression(
                        MemberAccessExpression(
                            IdentifierExpression(
                                this.EmittedName(signature.ContainingType, signature.ContainingType.Name)
                            ),
                            this.EmittedName(signature, signature.Name)
                        ),
                        arguments,
                        if typeArguments.Count == 0 {
                            default(IReadOnlyList[GTypeReference]?)
                        } else {
                            typeArguments
                        }
                    )
                )
            )
            statements.Add(
                ReturnStatement(
                    if elements.Count == 1 {
                        elements[0]
                    } else {
                        TupleLiteralExpression(elements)
                    }
                )
            )
            return MethodDeclaration(
                this.RecordDeconstructionAdapterName(method),
                []Parameter{receiverParameter},
                this.RecordDeconstructionResultType(method, outputTypes),
                BlockStatement(statements),
                typeParameters: typeParameters,
                visibility: MapVisibility(method, this.context, method.DeclaringSyntaxReferences[0].GetSyntax())
            )
        }

        private func ExtensionReceiverCanBeRecord(type ITypeSymbol) bool -> type.IsRecord ||
            type.SpecialType == SpecialType.System_Object ||
            type.SpecialType == SpecialType.System_ValueType ||
            type.TypeKind == TypeKind.Interface ||
            type.TypeKind == TypeKind.TypeParameter ||
            (type is INamedTypeSymbol named && this.IsSourceOrMigratedRecordType(named))

        private func MapRecordDeconstructionParameterTypes(method IMethodSymbol) List[GTypeReference] {
            let signature = method.PartialImplementationPart ?? method
            let syntax = signature.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as MethodDeclarationSyntax
            var parameters = this.MapParameters(signature, syntax?.ParameterList, skipFirst: false)
            if signature.PartialDefinitionPart != nil {
                parameters = this.ReconcilePartialMethodParameters(signature, parameters, isDeclaringPart: false)
            }
            let types = parameters.Select((parameter Parameter) -> parameter.Type).ToList()
            if signature.DeclaringSyntaxReferences.IsDefaultOrEmpty && this.TryResolveMigratedProducerDeconstruct(
                signature,
                out var sourceMethod,
                out _
            ) &&
                sourceMethod != nil {
                let sourceSignature = sourceMethod.PartialImplementationPart ?? sourceMethod
                for var i = 0; i < types.Count && i < sourceSignature.Parameters.Length; i++ {
                    if this.IsTranslatorWidenedDeclaration(sourceSignature.Parameters[i]) {
                        types[i] = MakeNullable(types[i])!!
                    }
                }
            }
            return types
        }

        private func MapRecordDeconstructionOutputParameterTypes(method IMethodSymbol) List[GTypeReference] {
            let unreduced = method.ReducedFrom ?? method
            let mapped = this.MapRecordDeconstructionParameterTypes(unreduced)
            return if unreduced.IsExtensionMethod {
                mapped.Skip(1).ToList()
            } else {
                mapped
            }
        }

        private func GetDeconstructOutputParameters(method IMethodSymbol) IReadOnlyList[IParameterSymbol] {
            let unreduced = method.ReducedFrom ?? method
            return if unreduced.IsExtensionMethod {
                unreduced.Parameters.Skip(1).ToList()
            } else {
                unreduced.Parameters
            }
        }

        private func RecordDeconstructionResultType(
            method IMethodSymbol,
            types IReadOnlyList[GTypeReference]
        ) GTypeReference {
            if types.Count == 1 {
                return types[0]
            }
            let outputParameters = this.GetDeconstructOutputParameters(method)
            let carrierTypes = List[GTypeReference](types.Count)
            for var i = 0; i < types.Count; i++ {
                carrierTypes.Add(
                    if i < outputParameters.Count && IsPointerOrFunctionPointerType(outputParameters[i].Type) {
                        cast[GTypeReference](NamedTypeReference("nuint"))
                    } else {
                        types[i]
                    }
                )
            }
            return TupleTypeReference(carrierTypes)
        }

        private func IsPointerOrFunctionPointerType(type ITypeSymbol?) bool -> type != nil &&
            (type.TypeKind == TypeKind.Pointer || type.TypeKind == TypeKind.FunctionPointer)

        private func HasPointerDeconstructTupleCarrier(
            method IMethodSymbol?,
            actualReceiverType ITypeSymbol? = nil
        ) bool {
            if method == nil || !this.UsesRecordDeconstructionAdapter(method, actualReceiverType) {
                return false
            }
            let outputs = this.GetDeconstructOutputParameters(method)
            return outputs.Count > 1 && outputs.Any(
                (parameter IParameterSymbol) -> this.IsPointerOrFunctionPointerType(parameter.Type)
            )
        }

        private func IsPointerDeconstructTupleOutput(
            method IMethodSymbol?,
            index int32,
            actualReceiverType ITypeSymbol? = nil
        ) bool {
            if method == nil || !this.HasPointerDeconstructTupleCarrier(method, actualReceiverType) {
                return false
            }
            let outputs = this.GetDeconstructOutputParameters(method)
            return index >= 0 && index < outputs.Count && this.IsPointerOrFunctionPointerType(outputs[index].Type)
        }

        private func TypeHasUnsafeSignatureMember(members IEnumerable[MemberDeclarationSyntax]) bool {
            for member in members {
                if member is not MethodDeclarationSyntax method || !method.Modifiers.Any(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnsafeKeyword
                ) {
                    continue
                }
                using let modelScope = this.context.UseSemanticModelFor(method.SyntaxTree)
                if this.context.GetDeclaredSymbol(method) is IMethodSymbol symbol &&
                    (
                    this.TypeContainsPointerOrFunctionPointer(symbol.ReturnType) || symbol.Parameters.Any(
                        (parameter IParameterSymbol) -> this.TypeContainsPointerOrFunctionPointer(parameter.Type)
                    )
                ) {
                    return true
                }
            }
            return false
        }

        private func TypeContainsPointerOrFunctionPointer(type ITypeSymbol?) bool {
            if type == nil {
                return false
            }
            if type.TypeKind == TypeKind.Pointer || type.TypeKind == TypeKind.FunctionPointer {
                return true
            }
            return switch type {
                case array is IArrayTypeSymbol: this.TypeContainsPointerOrFunctionPointer(array.ElementType)
                case named is INamedTypeSymbol: named.TypeArguments.Any(this.TypeContainsPointerOrFunctionPointer)
                default: false
            }
        }

        private func DirectlyImplementsImportedDeconstructContract(method IMethodSymbol?) bool {
            if method == nil ||
                method.IsStatic ||
                (method.Name != "Deconstruct" && !method.Name.EndsWith(".Deconstruct", StringComparison.Ordinal)) {
                return false
            }
            if method.IsOverride {
                return method.OverriddenMethod != nil &&
                    method.OverriddenMethod!!
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty &&
                    !this.TryResolveMigratedProducerDeconstruct(method.OverriddenMethod, out _, out _)
            }
            for explicitSlot in method.ExplicitInterfaceImplementations {
                if explicitSlot.Name == "Deconstruct" &&
                    explicitSlot
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty &&
                    !this.TryResolveMigratedProducerDeconstruct(explicitSlot, out _, out _) {
                    return true
                }
            }
            let owner = method.ContainingType
            if owner == nil {
                return false
            }
            for iface in owner.AllInterfaces {
                if !iface.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    continue
                }
                for slot in iface.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                    if !this.TryResolveMigratedProducerDeconstruct(slot, out _, out _) &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(owner.FindImplementationForInterfaceMember(slot), method) {
                        return true
                    }
                }
            }
            return false
        }

        private func GetImportedDeconstructContractMethods(symbol INamedTypeSymbol) List[IMethodSymbol] {
            let results = List[IMethodSymbol]()
            let seen = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
            for method in symbol.GetMembers().OfType[IMethodSymbol]() {
                if !method.IsPartialDefinition && EmittedNameAllocator.IsUserRecordDeconstruct(method) &&
                    this.DirectlyImplementsImportedDeconstructContract(method) && seen.Add(method) {
                    results.Add(method)
                }
            }
            let baseInterfaces = if symbol.BaseType is {} baseType {
                HashSet[INamedTypeSymbol](baseType.AllInterfaces, SymbolEqualityComparer.Default)
            } else {
                HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            }
            for iface in symbol.AllInterfaces {
                if !iface.DeclaringSyntaxReferences.IsDefaultOrEmpty || baseInterfaces.Contains(iface) {
                    continue
                }
                for slot in iface.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                    if this.TryResolveMigratedProducerDeconstruct(slot, out _, out _) {
                        continue
                    }
                    if symbol.FindImplementationForInterfaceMember(slot) is IMethodSymbol impl &&
                        !impl.IsStatic &&
                        !impl.IsPartialDefinition &&
                        (
                        EmittedNameAllocator.IsUserRecordDeconstruct(impl) ||
                            this
                            .nameAllocator
                            .HasRenamedDeconstructContract(impl) || this.TryResolveMigratedProducerDeconstruct(
                            impl,
                            out _,
                            out _
                        )
                    ) &&
                        seen.Add(impl) {
                        results.Add(impl)
                    }
                }
            }
            return results
        }

        private func GetInheritedImportedDeconstructContractMethods(symbol INamedTypeSymbol) List[IMethodSymbol] ->
        this
            .GetImportedDeconstructContractMethods(symbol)
            .Where((method IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(method.ContainingType, symbol))
            .ToList()

        private func GetInheritedRenamedDeconstructInterfaceContracts(symbol INamedTypeSymbol) List[
            (Slot IMethodSymbol, Implementation IMethodSymbol)
        ] {
            let results = List[(Slot IMethodSymbol, Implementation IMethodSymbol)]()
            let seenSlots = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
            let baseInterfaces = if symbol.BaseType is {} baseType {
                HashSet[INamedTypeSymbol](baseType.AllInterfaces, SymbolEqualityComparer.Default)
            } else {
                HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            }
            for iface in symbol.AllInterfaces {
                for slot in iface.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                    if !this.nameAllocator.HasRenamedDeconstructContract(slot) &&
                        !this.TryResolveMigratedProducerDeconstruct(slot, out _, out _) {
                        continue
                    }
                    let slotName = this.EmittedName(slot, slot.Name)
                    if slotName == nil || slotName == "Deconstruct" {
                        continue
                    }
                    if symbol.FindImplementationForInterfaceMember(slot) is IMethodSymbol impl &&
                        !impl.IsStatic &&
                        !impl.IsPartialDefinition &&
                        (
                        impl.IsImplicitlyDeclared ||
                            (
                            !SymbolEqualityComparer.Default.Equals(impl.ContainingType, symbol) && this.EmittedName(
                                impl,
                                impl.Name
                            ) != slotName
                        )
                    ) {
                        if symbol.BaseType is {} existingBase && baseInterfaces.Contains(iface) &&
                            !existingBase
                            .DeclaringSyntaxReferences
                            .IsDefaultOrEmpty &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(existingBase.FindImplementationForInterfaceMember(slot), impl) {
                            continue
                        }
                        if seenSlots.Add(slot) {
                            results.Add((slot, impl))
                        }
                    }
                }
            }
            return results
        }

        private func HasImportedDeconstructContractBridge(symbol INamedTypeSymbol) bool ->
        this.GetImportedDeconstructContractMethods(symbol).Count > 0

        private func NeedsValueTypeExplicitDeconstructHelper(method IMethodSymbol?) bool {
            if method == nil ||
                method.IsStatic ||
                method.IsPartialDefinition ||
                !method
                .ContainingType
                .IsValueType ||
                method
                .ExplicitInterfaceImplementations
                .IsDefaultOrEmpty {
                return false
            }
            let explicitSlot = method.ExplicitInterfaceImplementations[0]
            return this.nameAllocator.HasRenamedDeconstructContract(method) ||
                this
                .nameAllocator
                .HasRenamedDeconstructContract(explicitSlot) || this.TryResolveMigratedProducerDeconstruct(
                explicitSlot,
                out _,
                out _
            )
        }

        private func ValueTypeExplicitDeconstructHelperName(method IMethodSymbol) string {
            let original = method.OriginalDefinition
            if this.valueTypeExplicitDeconstructHelperNames.TryGetValue(original, out var existing) {
                return existing
            }
            let owner = original.ContainingType
            let occupied = HashSet[string](
                ReceiverTypeHierarchy(owner).SelectMany((type INamedTypeSymbol) -> type.GetMembers()).Select(
                    (member ISymbol) -> this.EmittedName(member, member.Name)!!
                ),
                StringComparer.Ordinal
            )
            occupied.UnionWith(this.nameAllocator.GetDeconstructionReservedNames(original))
            let ordinal = owner
                .GetMembers()
                .OfType[IMethodSymbol]()
                .Where((candidate IMethodSymbol) -> !candidate.ExplicitInterfaceImplementations.IsDefaultOrEmpty)
                .OrderBy((candidate IMethodSymbol) -> candidate.ToDisplayString(), StringComparer.Ordinal)
                .TakeWhile((candidate IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(candidate, original))
                .Count()
            const stem = "deconstructExplicit"
            var candidateName = stem
            var remaining = ordinal
            var suffix = 2
            for ; occupied.Contains(candidateName) || remaining > 0; suffix++ {
                if !occupied.Contains(candidateName) {
                    remaining--
                }
                candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            var assignedName = candidateName
            let membersToReserve = cast[IReadOnlyCollection[IMethodSymbol]]([]IMethodSymbol{original})
            while !LiftedLocalFunctionNameAllocator.For(this.context.Compilation).TryReserveContractMemberNames(
                membersToReserve,
                candidateName,
                out assignedName,
                role: "explicit-helper"
            ) {
                do {
                    candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
                    suffix++
                } while occupied.Contains(candidateName)
            }
            this.valueTypeExplicitDeconstructHelperNames[original] = assignedName
            return assignedName
        }

        private func BuildValueTypeExplicitDeconstructForwarder(method IMethodSymbol) MethodDeclaration? {
            if !this.NeedsValueTypeExplicitDeconstructHelper(method) {
                return nil
            }
            let syntaxNode = method.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax()
            let explicitInterfaceType = this.typeMapper.Map(
                method.ExplicitInterfaceImplementations[0].ContainingType,
                this.context,
                syntaxNode?.GetLocation()
            )
            if explicitInterfaceType == nil {
                return nil
            }
            return this.BuildDeconstructContractForwardingMethod(
                method,
                this.EmittedName(method, method.Name)!!,
                ThisExpression(),
                this.ValueTypeExplicitDeconstructHelperName(method),
                isOpen: false,
                isOverride: false,
                visibility: Visibility.Default,
                explicitInterfaceType: explicitInterfaceType
            )
        }

        private func NeedsProtectedImportedDeconstructHook(method IMethodSymbol?) bool -> method != nil &&
            !method.IsStatic &&
            !method.IsPartialDefinition &&
            (
            method.DeclaredAccessibility == Accessibility.Protected ||
                method.DeclaredAccessibility == Accessibility.ProtectedAndInternal
        ) &&
            EmittedNameAllocator.IsUserRecordDeconstruct(method) && this.DirectlyImplementsImportedDeconstructContract(
            method
        )

        private func ImportedProtectedDeconstructHookName(method IMethodSymbol) string {
            let original = method.OriginalDefinition
            if this.importedProtectedDeconstructHookNames.TryGetValue(original, out var existing) {
                return existing
            }
            let owner = original.ContainingType
            let occupied = HashSet[string](
                ReceiverTypeHierarchy(owner).SelectMany((type INamedTypeSymbol) -> type.GetMembers()).Select(
                    (member ISymbol) -> this.EmittedName(member, member.Name)!!
                ),
                StringComparer.Ordinal
            )
            occupied.UnionWith(this.nameAllocator.GetDeconstructionReservedNames(original))
            let ordinal = owner
                .GetMembers("Deconstruct")
                .OfType[IMethodSymbol]()
                .OrderBy((candidate IMethodSymbol) -> candidate.ToDisplayString(), StringComparer.Ordinal)
                .TakeWhile((candidate IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(candidate, original))
                .Count()
            const stem = "deconstructBridge"
            var candidateName = stem
            var remaining = ordinal
            var suffix = 2
            for ; occupied.Contains(candidateName) || remaining > 0; suffix++ {
                if !occupied.Contains(candidateName) {
                    remaining--
                }
                candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            var assignedName = candidateName
            let membersToReserve = cast[IReadOnlyCollection[IMethodSymbol]]([]IMethodSymbol{original})
            while !LiftedLocalFunctionNameAllocator.For(this.context.Compilation).TryReserveContractMemberNames(
                membersToReserve,
                candidateName,
                out assignedName,
                role: "protected-hook"
            ) {
                do {
                    candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
                    suffix++
                } while occupied.Contains(candidateName)
            }
            this.importedProtectedDeconstructHookNames[original] = assignedName
            return assignedName
        }

        private func BuildImportedProtectedDeconstructHook(
            method IMethodSymbol,
            ownerKind TypeDeclarationKind
        ) MethodDeclaration? {
            if ownerKind != TypeDeclarationKind.DataClass || !this.NeedsProtectedImportedDeconstructHook(method) {
                return nil
            }
            return this.BuildDeconstructContractForwardingMethod(
                method,
                this.ImportedProtectedDeconstructHookName(method),
                ThisExpression(),
                this.EmittedName(method, method.Name)!!,
                isOpen: false,
                isOverride: false,
                visibility: Visibility.Internal
            )
        }

        private func IsExplicitImportedDeconstructOnlyInterface(method IMethodSymbol) bool {
            if method.ExplicitInterfaceImplementations.IsDefaultOrEmpty {
                return false
            }
            let iface = method.ExplicitInterfaceImplementations[0].ContainingType
            if iface == nil || !iface.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                return false
            }
            let owner = method.ContainingType
            if owner == nil {
                return false
            }
            for candidateIface in[]INamedTypeSymbol{iface}.Concat(iface.AllInterfaces) {
                for member in candidateIface.GetMembers() {
                    if member is not IMethodSymbol ifaceMethod || ifaceMethod.Name != "Deconstruct" {
                        return false
                    }
                    if owner.FindImplementationForInterfaceMember(ifaceMethod) == nil {
                        return false
                    }
                }
            }
            return true
        }

        private func HasConflictingImportedDeconstructSignature(method IMethodSymbol) bool {
            let owner = method.ContainingType
            if owner == nil {
                return false
            }
            for other in this.GetImportedDeconstructContractMethods(owner) {
                if SymbolEqualityComparer.Default.Equals(other, method) ||
                    other
                    .Parameters
                    .Length != method
                    .Parameters
                    .Length ||
                    other.Arity != method.Arity {
                    continue
                }
                var sameParameters = true
                for var i = 0; i < method.Parameters.Length; i++ {
                    if other
                        .Parameters[i]
                        .RefKind != method
                        .Parameters[i]
                        .RefKind ||
                        !SymbolEqualityComparer
                        .Default
                        .Equals(other.Parameters[i].Type, method.Parameters[i].Type) {
                        sameParameters = false
                        break
                    }
                }
                if sameParameters {
                    return true
                }
            }
            return false
        }

        private func RemoveBridgedExplicitInterfaces(
            symbol INamedTypeSymbol,
            node TypeDeclarationSyntax,
            interfaces List[GTypeReference]
        ) {
            let bridged = HashSet[string](StringComparer.Ordinal)
            for method in this.GetImportedDeconstructContractMethods(symbol) {
                if this.IsExplicitImportedDeconstructOnlyInterface(method) {
                    let iface = method.ExplicitInterfaceImplementations[0].ContainingType
                    if this.typeMapper.Map(iface, this.context, node.GetLocation()) is {} mapped {
                        bridged.Add(GSharpPrinter.RenderTypeReference(mapped))
                    }
                }
            }
            if bridged.Count == 0 {
                return
            }
            for var i = interfaces.Count - 1; i >= 0; i-- {
                if bridged.Contains(GSharpPrinter.RenderTypeReference(interfaces[i])) {
                    interfaces.RemoveAt(i)
                }
            }
        }

        private func BuildImplicitRecordDeconstructMethod(
            slot IMethodSymbol,
            impl IMethodSymbol,
            emittedMethodName string,
            isOpen bool
        ) MethodDeclaration {
            let syntax = slot.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as MethodDeclarationSyntax
            using let modelScope = if syntax != nil {
                this.context.UseSemanticModelFor(syntax.SyntaxTree)
            } else {
                default(IDisposable?)
            }
            let parameters = this.MapParameters(slot, syntax?.ParameterList, skipFirst: false)
            let statements = List[GStatement](parameters.Count)
            for var i = 0; i < parameters.Count && i < impl.Parameters.Length; i++ {
                let implParam = impl.Parameters[i]
                let prop = ReceiverTypeHierarchy(impl.ContainingType).SelectMany(
                    (owner INamedTypeSymbol) -> owner.GetMembers(implParam.Name).OfType[IPropertySymbol]()
                )
                    .FirstOrDefault()
                let memberName = if prop != nil {
                    this.EmittedName(prop, prop.Name)!!
                } else {
                    this.EmittedName(implParam, implParam.Name)!!
                }
                statements.Add(
                    AssignmentStatement(
                        IdentifierExpression(parameters[i].Name),
                        MemberAccessExpression(ThisExpression(), memberName)
                    )
                )
            }
            return MethodDeclaration(
                emittedMethodName,
                parameters,
                returnType: nil,
                BlockStatement(statements),
                visibility: Visibility.Public,
                isOpen: isOpen
            )
        }

        private func BuildDeconstructContractForwardingMethod(
            method IMethodSymbol,
            emittedMethodName string,
            targetReceiver GExpression,
            targetMethodName string,
            isOpen bool,
            isOverride bool,
            visibility Visibility = Visibility.Public,
            explicitInterfaceType GTypeReference? = nil
        ) MethodDeclaration {
            let signature = method.PartialImplementationPart ?? method
            let syntax = signature.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() as MethodDeclarationSyntax
            using let modelScope = if syntax != nil {
                this.context.UseSemanticModelFor(syntax.SyntaxTree)
            } else {
                default(IDisposable?)
            }
            var parameters = this.MapParameters(signature, syntax?.ParameterList, skipFirst: false)
            if signature.PartialDefinitionPart != nil {
                parameters = this.ReconcilePartialMethodParameters(signature, parameters, isDeclaringPart: false)
            }
            let returnType = if signature.ReturnsVoid {
                default(GTypeReference?)
            } else if syntax != nil {
                this.MapReturnType(signature, syntax, preserveEnvelope: true)
            } else {
                this.typeMapper.Map(signature.ReturnType, this.context, location: nil)
            }
            let typeParameters = this.MapMethodTypeParameters(signature, signature.PartialDefinitionPart)
            let typeArguments = if signature.TypeParameters.Length == 0 {
                default(IReadOnlyList[GTypeReference]?)
            } else {
                signature
                    .TypeParameters
                    .Select(
                    (tp ITypeParameterSymbol) -> cast[GTypeReference](NamedTypeReference(this.EmittedName(tp, tp.Name)))
                )
                    .ToList()
            }
            let arguments = List[GExpression](parameters.Count)
            for var i = 0; i < parameters.Count; i++ {
                let refKind = if i < signature.Parameters.Length {
                    signature.Parameters[i].RefKind
                } else {
                    RefKind.None
                }
                let argument = switch refKind {
                    case RefKind.Out: cast[GExpression](OutArgumentExpression("out", parameters[i].Name))
                    case RefKind.Ref: cast[GExpression](UnaryExpression("&", IdentifierExpression(parameters[i].Name)))
                    case RefKind.In: cast[GExpression](OutArgumentExpression("in", parameters[i].Name))
                    default: cast[GExpression](IdentifierExpression(parameters[i].Name))
                }
                arguments.Add(argument)
            }
            let call = InvocationExpression(
                MemberAccessExpression(targetReceiver, targetMethodName),
                arguments,
                typeArguments
            )
            let isRefReturn = signature.ReturnsByRef || signature.ReturnsByRefReadonly
            let bodyStatement GStatement = if signature.ReturnsVoid {
                ExpressionStatement(call)
            } else {
                ReturnStatement(call, isRef: isRefReturn)
            }
            return MethodDeclaration(
                emittedMethodName,
                parameters,
                returnType,
                BlockStatement([]GStatement{bodyStatement}),
                typeParameters: typeParameters,
                visibility: visibility,
                isOpen: isOpen,
                isOverride: isOverride,
                explicitInterfaceType: explicitInterfaceType,
                isRefReturn: isRefReturn,
                isReadOnlyRefReturn: signature.ReturnsByRefReadonly
            )
        }

        private func ImportedBaseDeconstructHelperName(method IMethodSymbol) string {
            let original = method.OriginalDefinition
            if this.importedBaseDeconstructHelperNames.TryGetValue(original, out var existing) {
                return existing
            }
            let owner = original.ContainingType
            let occupied = HashSet[string](
                ReceiverTypeHierarchy(owner).SelectMany((type INamedTypeSymbol) -> type.GetMembers()).Select(
                    (member ISymbol) -> this.EmittedName(member, member.Name)!!
                ),
                StringComparer.Ordinal
            )
            occupied.UnionWith(this.nameAllocator.GetDeconstructionReservedNames(original))
            let ordinal = this
                .GetImportedDeconstructContractMethods(owner)
                .Where((candidate IMethodSymbol) -> candidate.IsOverride)
                .OrderBy((candidate IMethodSymbol) -> candidate.ToDisplayString(), StringComparer.Ordinal)
                .TakeWhile((candidate IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(candidate, original))
                .Count()
            const stem = "baseDeconstruct"
            var candidateName = stem
            var remaining = ordinal
            var suffix = 2
            for ; occupied.Contains(candidateName) || remaining > 0; suffix++ {
                if !occupied.Contains(candidateName) {
                    remaining--
                }
                candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            var assignedName = candidateName
            let membersToReserve = cast[IReadOnlyCollection[IMethodSymbol]]([]IMethodSymbol{original})
            while !LiftedLocalFunctionNameAllocator.For(this.context.Compilation).TryReserveContractMemberNames(
                membersToReserve,
                candidateName,
                out assignedName,
                role: "base-helper"
            ) {
                do {
                    candidateName = stem + suffix.ToString(CultureInfo.InvariantCulture)
                    suffix++
                } while occupied.Contains(candidateName)
            }
            this.importedBaseDeconstructHelperNames[original] = assignedName
            return assignedName
        }

        private func TryGetImportedBaseDeconstructHelperName(
            site SyntaxNode,
            baseMethod IMethodSymbol,
            out helperName string?
        ) bool {
            helperName = nil
            let enclosingType = this
                .state
                .CurrentEmittedAggregate ??
                this
                .context
                .SemanticModel
                .GetEnclosingSymbol(site.SpanStart)
                ?.ContainingType
            if enclosingType == nil || !enclosingType.IsRecord || enclosingType.IsValueType {
                return false
            }
            for contractMethod in this.GetImportedDeconstructContractMethods(enclosingType) {
                if contractMethod.IsOverride &&
                    contractMethod.OverriddenMethod != nil &&
                    !contractMethod.OverriddenMethod!!.IsAbstract &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(contractMethod.OverriddenMethod!!.OriginalDefinition, baseMethod.OriginalDefinition) {
                    helperName = this.ImportedBaseDeconstructHelperName(contractMethod)
                    return true
                }
            }
            return false
        }

        private func BuildImportedDeconstructForwarder(
            method IMethodSymbol,
            ownerKind TypeDeclarationKind
        ) MethodDeclaration? {
            if ownerKind != TypeDeclarationKind.Class && ownerKind != TypeDeclarationKind.Struct {
                return nil
            }
            if method.IsStatic || method.IsPartialDefinition || this.EmittedName(method, method.Name) == method.Name ||
                !this.DirectlyImplementsImportedDeconstructContract(method) {
                return nil
            }
            let isOverride = method.IsOverride &&
                method.OverriddenMethod != nil &&
                method.OverriddenMethod!!
                .DeclaringSyntaxReferences
                .IsDefaultOrEmpty
            let slotVisibility = if isOverride &&
                (
                method.DeclaredAccessibility == Accessibility.Protected ||
                    method.DeclaredAccessibility == Accessibility.ProtectedAndInternal
            ) {
                Visibility.Protected
            } else {
                Visibility.Public
            }
            return this.BuildDeconstructContractForwardingMethod(
                method,
                "Deconstruct",
                ThisExpression(),
                this.EmittedName(method, method.Name)!!,
                isOpen: ownerKind == TypeDeclarationKind.Class && !method.ContainingType.IsSealed && !isOverride,
                isOverride: isOverride,
                visibility: slotVisibility
            )
        }

        private func SelectsBaseCopyConstructor(symbol INamedTypeSymbol, baseCopyCtor IMethodSymbol) bool {
            for ctor in symbol.InstanceConstructors {
                if ctor.IsImplicitlyDeclared {
                    continue
                }
                for reference in ctor.DeclaringSyntaxReferences {
                    if reference.GetSyntax() is ConstructorDeclarationSyntax{Initializer: {} initializer} &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(
                        (
                            this
                                .context
                                .Compilation
                                .GetSemanticModel(reference.SyntaxTree)
                                .GetSymbolInfo(initializer)
                                .Symbol as IMethodSymbol
                        )?.OriginalDefinition,
                        baseCopyCtor.OriginalDefinition
                    ) {
                        return true
                    }
                }
            }
            return false
        }

        private func BuildImportedDeconstructContractBridge(
            symbol INamedTypeSymbol,
            node TypeDeclarationSyntax,
            baseType GTypeReference?,
            typeParameters IReadOnlyList[TypeParameter],
            isUnsafe bool
        ) TypeDeclaration? {
            let contractMethods = this.GetImportedDeconstructContractMethods(symbol)
            if contractMethods.Count == 0 {
                return nil
            }
            let bridgeName = this.AllocateImportedDeconstructBridgeName(symbol)
            let bridgeMembers = List[GMember]()
            var bridgeIsUnsafe = isUnsafe
            if symbol.BaseType is {} baseSymbol && baseSymbol.SpecialType != SpecialType.System_Object {
                let compilations = this.context.RepositoryCompilations ?? this.context.SiblingCompilations
                let isSourceOrMigratedBase = !baseSymbol
                    .DeclaringSyntaxReferences
                    .IsDefaultOrEmpty ||
                    (
                    compilations != nil && ObliviousNullabilityAnalyzer.RunSourceDeclarations(
                        baseSymbol.OriginalDefinition,
                        compilations
                    )
                        .Any()
                )
                let accessibleConstructors = List[IMethodSymbol]()
                for ctor in baseSymbol.InstanceConstructors {
                    if !this.context.Compilation.IsSymbolAccessibleWithin(ctor, symbol) {
                        continue
                    }
                    let isBaseCopyCtor = ctor
                        .Parameters
                        .Length == 1 &&
                        ctor
                        .Parameters[0]
                        .RefKind == RefKind.None &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(ctor.Parameters[0].Type, baseSymbol)
                    if isBaseCopyCtor {
                        if !this.SelectsBaseCopyConstructor(symbol, ctor) {
                            continue
                        }
                        if isSourceOrMigratedBase {
                            this.context.ReportUnsupported(
                                node,
                                "record Deconstruct bridge cannot forward an explicit base copy-constructor call to a source record."
                            )
                            return nil
                        }
                    }
                    accessibleConstructors.Add(ctor)
                }
                if accessibleConstructors.Any((ctor IMethodSymbol) -> ctor.Parameters.Length > 0) {
                    for ctor in accessibleConstructors {
                        if ctor.Parameters.Any(
                            (parameter IParameterSymbol) -> this.TypeContainsPointerOrFunctionPointer(parameter.Type)
                        ) {
                            bridgeIsUnsafe = true
                        }
                        let ctorSyntax = ctor
                            .DeclaringSyntaxReferences
                            .FirstOrDefault()
                            ?.GetSyntax() as ConstructorDeclarationSyntax
                        using let ctorModelScope = if ctorSyntax != nil {
                            this.context.UseSemanticModelFor(ctorSyntax.SyntaxTree)
                        } else {
                            default(IDisposable?)
                        }
                        let ctorParameters = this.MapParameters(ctor, ctorSyntax?.ParameterList, skipFirst: false)
                        let baseArguments = List[GExpression](ctorParameters.Count)
                        for var i = 0; i < ctorParameters.Count; i++ {
                            let refKind = if i < ctor.Parameters.Length {
                                ctor.Parameters[i].RefKind
                            } else {
                                RefKind.None
                            }
                            let arg = switch refKind {
                                case RefKind.Out: cast[GExpression](
                                    OutArgumentExpression("out", ctorParameters[i].Name)
                                )
                                case RefKind.Ref: cast[GExpression](
                                    UnaryExpression("&", IdentifierExpression(ctorParameters[i].Name))
                                )
                                case RefKind.In: cast[GExpression](OutArgumentExpression("in", ctorParameters[i].Name))
                                default: cast[GExpression](IdentifierExpression(ctorParameters[i].Name))
                            }
                            baseArguments.Add(arg)
                        }
                        let ctorVisibility = switch ctor.DeclaredAccessibility {
                            case Accessibility.Protected, Accessibility.ProtectedAndInternal: Visibility.Protected
                            case Accessibility.Internal: Visibility.Internal
                            default: Visibility.Public
                        }
                        bridgeMembers.Add(
                            ConstructorDeclaration(
                                ctorParameters,
                                BlockStatement(Array.Empty[GStatement]()),
                                baseArguments: baseArguments,
                                visibility: ctorVisibility
                            )
                        )
                    }
                }
            }
            let selfType = NamedTypeReference(
                this.EmittedName(symbol, symbol.Name),
                typeParameters.Select(
                    (parameter TypeParameter) -> cast[GTypeReference](NamedTypeReference(parameter.Name))
                )
                    .ToList()
            )
            let bridgeInterfaces = List[GTypeReference]()
            let seenBridgeInterfaces = HashSet[string](StringComparer.Ordinal)
            for method in contractMethods {
                let signature = method.PartialImplementationPart ?? method
                if this.TypeContainsPointerOrFunctionPointer(signature.ReturnType) || signature.Parameters.Any(
                    (parameter IParameterSymbol) -> this.TypeContainsPointerOrFunctionPointer(parameter.Type)
                ) {
                    bridgeIsUnsafe = true
                }
                let isDirectlyOnSymbol = SymbolEqualityComparer.Default.Equals(method.ContainingType, symbol)
                let isOverride = isDirectlyOnSymbol && method.IsOverride
                let useProtectedHook = isDirectlyOnSymbol && this.NeedsProtectedImportedDeconstructHook(method)
                let targetMethodName = if useProtectedHook {
                    this.ImportedProtectedDeconstructHookName(method)
                } else {
                    this.EmittedName(method, method.Name)!!
                }
                var explicitBridgeIface GTypeReference? = nil
                if isDirectlyOnSymbol && this.IsExplicitImportedDeconstructOnlyInterface(method) {
                    let explicitIface = method.ExplicitInterfaceImplementations[0].ContainingType
                    explicitBridgeIface = this.typeMapper.Map(explicitIface, this.context, node.GetLocation())
                    if explicitBridgeIface != nil && seenBridgeInterfaces.Add(
                        GSharpPrinter.RenderTypeReference(explicitBridgeIface)
                    ) {
                        bridgeInterfaces.Add(explicitBridgeIface)
                    }
                }
                let bridgeMethodVisibility = if explicitBridgeIface != nil {
                    Visibility.Default
                } else if isOverride &&
                    (
                    method.DeclaredAccessibility == Accessibility.Protected ||
                        method.DeclaredAccessibility == Accessibility.ProtectedAndInternal
                ) {
                    Visibility.Protected
                } else {
                    Visibility.Public
                }
                bridgeMembers.Add(
                    this.BuildDeconstructContractForwardingMethod(
                        method,
                        "Deconstruct",
                        ParenthesizedExpression(
                            ConversionExpression(selfType, ThisExpression(), isCheckedReferenceCast: true)
                        ),
                        targetMethodName,
                        isOpen: explicitBridgeIface == nil,
                        isOverride: isOverride,
                        visibility: bridgeMethodVisibility,
                        explicitInterfaceType: explicitBridgeIface
                    )
                )
                if isOverride && method.OverriddenMethod != nil && !method.OverriddenMethod!!.IsAbstract {
                    bridgeMembers.Add(
                        this.BuildDeconstructContractForwardingMethod(
                            method,
                            this.ImportedBaseDeconstructHelperName(method),
                            IdentifierExpression("base"),
                            "Deconstruct",
                            isOpen: false,
                            isOverride: false,
                            visibility: bridgeMethodVisibility
                        )
                    )
                }
            }
            return TypeDeclaration(
                TypeDeclarationKind.Class,
                bridgeName,
                typeParameters: typeParameters,
                baseType: baseType,
                interfaces: if bridgeInterfaces.Count == 0 {
                    default(IReadOnlyList[GTypeReference]?)
                } else {
                    bridgeInterfaces
                },
                members: bridgeMembers,
                visibility: MapVisibility(symbol, this.context, node),
                isAbstract: true,
                isUnsafe: bridgeIsUnsafe
            )
        }

        private func AllocateImportedDeconstructBridgeName(symbol INamedTypeSymbol) string {
            let occupied = HashSet[string](StringComparer.Ordinal)
            for member in symbol.GetMembers() {
                occupied.Add(member.Name)
                if this.EmittedName(member, member.Name) is {} emittedSelfMember {
                    occupied.Add(emittedSelfMember)
                }
            }
            if symbol.ContainingType is {} containingType {
                for member in containingType.GetMembers() {
                    occupied.Add(member.Name)
                    if this.EmittedName(member, member.Name) is {} emittedMember {
                        occupied.Add(emittedMember)
                    }
                }
            } else if symbol.ContainingNamespace is {} containingNamespace {
                for member in containingNamespace.GetMembers() {
                    occupied.Add(member.Name)
                    if this.EmittedName(member, member.Name) is {} emittedMember {
                        occupied.Add(emittedMember)
                    }
                }
            }
            let stem = symbol.Name.TrimStart('$') + "DeconstructBridge"
            var candidate = stem
            for var suffix = 2; occupied.Contains(candidate); suffix++ {
                candidate = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            return candidate
        }

        private func HasRenamedNonRecordDeconstructContract(method IMethodSymbol?) bool ->
        method != nil &&
            (method.Name == "Deconstruct" || method.Name.EndsWith(".Deconstruct", StringComparison.Ordinal)) &&
            !this.IsEffectiveUserRecordDeconstruct(method) && this.EmittedName(method, "Deconstruct") != "Deconstruct"

        private func IsEffectiveUserRecordDeconstruct(method IMethodSymbol?) bool {
            if EmittedNameAllocator.IsUserRecordDeconstruct(method) {
                return true
            }
            return this.TryResolveMigratedProducerDeconstruct(method, out var sourceMethod, out _) &&
                EmittedNameAllocator.IsUserRecordDeconstruct(sourceMethod)
        }

        private func IsSourceOrMigratedRecordType(type INamedTypeSymbol?) bool {
            if type == nil {
                return false
            }
            if type.IsRecord {
                return true
            }
            let compilations = this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            if compilations != nil {
                for source in ObliviousNullabilityAnalyzer.RunSourceDeclarations(type.OriginalDefinition, compilations)
                    .OfType[INamedTypeSymbol]() {
                    if source.IsRecord {
                        return true
                    }
                }
            }
            return ReceiverTypeHierarchy(type).SelectMany(
                (owner INamedTypeSymbol) -> owner.GetMembers("Deconstruct").OfType[IMethodSymbol]()
            )
                .Any(this.IsEffectiveUserRecordDeconstruct)
        }

        private func IsExtensionRecordDeconstruct(method IMethodSymbol?, actualReceiverType ITypeSymbol? = nil) bool {
            let extension = method?.ReducedFrom ?? method
            if extension == nil ||
                !extension.IsExtensionMethod ||
                extension.Name != "Deconstruct" ||
                extension
                .Parameters
                .Length < 2 {
                return false
            }
            let receiverType = actualReceiverType as INamedTypeSymbol ??
                (
                if method?.ReducedFrom != nil {
                    method?.ReceiverType
                } else {
                    extension.Parameters[0].Type
                }
            ) as INamedTypeSymbol ??
                extension
                .Parameters[0]
                .Type as INamedTypeSymbol
            if !this.IsSourceOrMigratedRecordType(receiverType) {
                return false
            }
            return ReceiverTypeHierarchy(receiverType!!).SelectMany(
                (owner INamedTypeSymbol) -> owner.GetMembers("Deconstruct").OfType[IMethodSymbol]()
            )
                .Any(this.IsEffectiveUserRecordDeconstruct)
        }

        private func IsImportedRecordOrRecordStruct(type INamedTypeSymbol?) bool {
            if type == nil {
                return false
            }
            if type.IsRecord {
                return true
            }
            if type.TypeKind != TypeKind.Struct {
                return false
            }
            if type
                .GetMembers("PrintMembers")
                .OfType[IMethodSymbol]()
                .Any(
                (member IMethodSymbol) -> member
                    .Parameters
                    .Length == 1 &&
                    member
                    .Parameters[0]
                    .Type
                    .ToDisplayString() == "System.Text.StringBuilder"
            ) {
                return true
            }
            return type
                .GetMembers("op_Equality")
                .OfType[IMethodSymbol]()
                .Any(
                (member IMethodSymbol) -> member.GetAttributes().Any(
                    (attribute AttributeData) -> attribute.AttributeClass?.ToDisplayString() ==
                    "System.Runtime.CompilerServices.CompilerGeneratedAttribute"
                )
            )
        }

        private func IsImportedRecordUserDeconstruct(method IMethodSymbol?) bool -> method != nil &&
            method.Name == "Deconstruct" &&
            method
            .DeclaringSyntaxReferences
            .IsDefaultOrEmpty &&
            this.IsImportedRecordOrRecordStruct(method.ContainingType) && !this.TryResolveMigratedProducerDeconstruct(
            method,
            out _,
            out _
        ) &&
            !method
            .GetAttributes().Any(
            (attribute AttributeData) -> attribute.AttributeClass?.ToDisplayString() ==
            "System.Runtime.CompilerServices.CompilerGeneratedAttribute"
        )

        private func UsesRecordDeconstructionAdapter(
            method IMethodSymbol?,
            actualReceiverType ITypeSymbol? = nil
        ) bool -> this.IsEffectiveUserRecordDeconstruct(method) || this.HasRenamedNonRecordDeconstructContract(
            method
        ) ||
            this.IsExtensionRecordDeconstruct(method, actualReceiverType) || this.IsImportedRecordUserDeconstruct(
            method
        )

        private func BuildInlineOutDeconstructCall(
            callee GExpression,
            initialArguments List[GExpression],
            method IMethodSymbol,
            typeArguments IReadOnlyList[GTypeReference]? = nil,
            prologue List[GStatement]? = nil
        ) GExpression {
            let outputTypes = this.MapRecordDeconstructionOutputParameterTypes(method)
            let outputParameters = this.GetDeconstructOutputParameters(method)
            let arguments = List[GExpression](initialArguments)
            let tupleElements = List[GExpression](outputTypes.Count)
            let statements = List[GStatement]()
            if prologue != nil {
                statements.AddRange(prologue)
            }
            for var i = 0; i < outputTypes.Count; i++ {
                let temp = this.NewSpillName()
                let local = IdentifierExpression(temp)
                statements.Add(LocalDeclarationStatement(BindingKind.Var, temp, outputTypes[i]))
                arguments.Add(OutArgumentExpression("out", temp))
                tupleElements.Add(
                    if outputTypes.Count > 1 && i < outputParameters.Count && this.IsPointerOrFunctionPointerType(
                        outputParameters[i].Type
                    ) {
                        cast[GExpression](
                            ConversionExpression(NamedTypeReference("nuint"), local, isCheckedReferenceCast: true)
                        )
                    } else {
                        cast[GExpression](local)
                    }
                )
            }
            statements.Add(ExpressionStatement(InvocationExpression(callee, arguments, typeArguments)))
            let result GExpression = if tupleElements.Count == 1 {
                tupleElements[0]
            } else {
                TupleLiteralExpression(tupleElements)
            }
            return BlockExpression(statements, result)
        }

        private func RewriteRecordDeconstruction(
            value GExpression?,
            method IMethodSymbol?,
            diagnosticSite SyntaxNode,
            receiverSyntax ExpressionSyntax? = nil,
            emittedReceiverType GTypeReference? = nil,
            actualReceiverType ITypeSymbol? = nil
        ) GExpression? {
            let receiverType = actualReceiverType ?? if receiverSyntax != nil {
                this.context.GetTypeInfo(receiverSyntax).Type
            } else {
                nil
            }
            if method != nil && this.UsesRecordDeconstructionAdapter(method, receiverType) &&
                this
                .GetDeconstructOutputParameters(method).Any(
                (parameter IParameterSymbol) -> parameter.Type.IsRefLikeType
            ) {
                this.context.ReportUnsupported(
                    diagnosticSite,
                    "record Deconstruct outputs with ref-like types cannot use a tuple adapter."
                )
                return value
            }
            if this.IsImportedRecordUserDeconstruct(method) {
                var receiver = if receiverSyntax != nil {
                    this.TranslateReceiverWithNullForgiveness(receiverSyntax, value)
                } else if emittedReceiverType?.IsNullable == true {
                    EnsureNonNullAssertion(value)
                } else {
                    value
                }
                var receiverPrologue List[GStatement]? = nil
                if method!!.ContainingType.IsValueType {
                    let receiverCopy = this.NewSpillName()
                    receiverPrologue = List[GStatement]{
                        LocalDeclarationStatement(BindingKind.Var, receiverCopy, initializer: receiver)
                    }
                    receiver = IdentifierExpression(receiverCopy)
                }
                return this.BuildInlineOutDeconstructCall(
                    MemberAccessExpression(receiver, "Deconstruct"),
                    List[GExpression](),
                    method!!,
                    prologue: receiverPrologue
                )
            }
            if this.IsExtensionRecordDeconstruct(method, receiverType) {
                let constructedExtension = method!!.ReducedFrom ?? method!!
                let extension = constructedExtension.OriginalDefinition
                this.typeMapper.TrackExtensionMethodNamespace(extension)
                let receiverParam = constructedExtension.Parameters[0]
                let originalReceiverParam = extension.Parameters[0]
                let receiverAcceptsNull = receiverParam
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated ||
                    this.IsTranslatorWidenedDeclaration(originalReceiverParam)
                let receiver = if receiverSyntax != nil {
                    this.ForgiveNullableReferenceValue(
                        receiverSyntax,
                        value ?? this.TranslateExpression(receiverSyntax),
                        receiverParam.Type,
                        originalReceiverParam,
                        includePromotedValue: true
                    )
                } else if emittedReceiverType?.IsNullable == true && !receiverAcceptsNull {
                    EnsureNonNullAssertion(value)
                } else {
                    value
                }
                var receiverPrologue List[GStatement]? = nil
                var receiverArgument = receiver
                if receiverParam.RefKind == RefKind.Ref ||
                    receiverParam.RefKind == RefKind.Out ||
                    receiverParam.RefKind == RefKind.In ||
                    receiverParam.RefKind == RefKind
                    .RefReadOnlyParameter {
                    let receiverCopy = this.NewSpillName()
                    receiverPrologue = List[GStatement]{
                        LocalDeclarationStatement(BindingKind.Var, receiverCopy, initializer: receiver)
                    }
                    receiverArgument = PassStaticExtensionHelperReceiver(
                        IdentifierExpression(receiverCopy),
                        constructedExtension
                    )
                } else {
                    receiverArgument = PassStaticExtensionHelperReceiver(receiver, constructedExtension)
                }
                if extension.DeclaringSyntaxReferences.IsDefaultOrEmpty && !this.TryResolveMigratedProducerDeconstruct(
                    extension,
                    out _,
                    out _
                ) {
                    return this.BuildInlineOutDeconstructCall(
                        MemberAccessExpression(
                            this.StaticQualifierReceiver(extension.ContainingType, diagnosticSite.GetLocation()),
                            this.EmittedName(extension, extension.Name)
                        ),
                        List[GExpression]{receiverArgument!!},
                        constructedExtension,
                        prologue: receiverPrologue
                    )
                }
                let adapterCall GExpression = InvocationExpression(
                    MemberAccessExpression(
                        this.StaticQualifierReceiver(extension.ContainingType, diagnosticSite.GetLocation()),
                        this.RecordDeconstructionAdapterName(extension)
                    ),
                    []GExpression{receiverArgument!!}
                )
                return if receiverPrologue != nil {
                    BlockExpression(receiverPrologue, adapterCall)
                } else {
                    adapterCall
                }
            }
            if !this.UsesRecordDeconstructionAdapter(method, receiverType) {
                return value
            }
            let receiver = if receiverSyntax != nil {
                this.TranslateReceiverWithNullForgiveness(receiverSyntax, value)
            } else if emittedReceiverType?.IsNullable == true {
                EnsureNonNullAssertion(value)
            } else {
                value
            }
            return InvocationExpression(
                MemberAccessExpression(receiver, this.RecordDeconstructionAdapterName(method!!)),
                Array.Empty[GExpression]()
            )
        }

        private func DisambiguateAgainstMigratedProducerDeconstruct(symbol ISymbol?, allocated string?) string? {
            if symbol == nil ||
                allocated == nil ||
                (
                !allocated.StartsWith("deconstruct", StringComparison.OrdinalIgnoreCase) && !symbol.Name.Contains(
                    "deconstruct",
                    StringComparison.OrdinalIgnoreCase
                )
            ) ||
                symbol.ContainingType is not{} initialOwner ||
                !(
                symbol is IFieldSymbol || symbol is IPropertySymbol || symbol is IMethodSymbol || symbol is IEventSymbol
            ) {
                return allocated
            }
            let compilations = this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            if compilations == nil {
                return allocated
            }
            var targetSymbol = symbol
            var targetAllocated = allocated
            var targetCompilation = this.context.Compilation
            if targetSymbol.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                let sourceDeclaration = ObliviousNullabilityAnalyzer.RunSourceDeclarations(
                    targetSymbol.OriginalDefinition,
                    compilations
                )
                    .FirstOrDefault()
                if sourceDeclaration == nil || sourceDeclaration.ContainingType == nil {
                    return allocated
                }
                let declaringCompilation = compilations.FirstOrDefault(
                    (compilation Compilation) -> compilation
                        .Assembly
                        .Identity
                        .Equals(sourceDeclaration.ContainingAssembly.Identity)
                )
                if declaringCompilation == nil {
                    return allocated
                }
                targetSymbol = sourceDeclaration
                targetCompilation = declaringCompilation
                targetAllocated = EmittedNameAllocator.For(declaringCompilation).GetName(sourceDeclaration) ?? allocated
            }
            if targetSymbol.ContainingType == nil {
                return targetAllocated
            }
            let targetAllocator = EmittedNameAllocator.For(targetCompilation)
            let contractMembers = targetAllocator.GetSymbolContractMembers(targetSymbol)
            for contractMember in contractMembers {
                if contractMember is IMethodSymbol method &&
                    (
                    EmittedNameAllocator.For(
                        compilations.FirstOrDefault(
                            (compilation Compilation) -> compilation
                                .Assembly
                                .Identity
                                .Equals(method.ContainingAssembly.Identity)
                        ) ??
                            targetCompilation
                    )
                        .HasRenamedDeconstructContract(method) || this.TryResolveMigratedProducerDeconstruct(
                        method,
                        out _,
                        out _
                    )
                ) {
                    return targetAllocated
                }
            }
            let contractOwners = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            for contractMember in contractMembers {
                if contractMember.ContainingType is {} memberOwner {
                    contractOwners.Add(memberOwner)
                }
                if contractMember.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                    for sourceContractMember in ObliviousNullabilityAnalyzer.RunSourceDeclarations(
                        contractMember.OriginalDefinition,
                        compilations
                    ) {
                        if sourceContractMember.ContainingType is {} sourceOwner {
                            contractOwners.Add(sourceOwner)
                        }
                    }
                }
            }
            let reserved = HashSet[string](StringComparer.Ordinal)
            for contractOwner in contractOwners {
                for candidateOwner in ReceiverTypeHierarchy(contractOwner).Concat(contractOwner.AllInterfaces) {
                    for candidate in candidateOwner.GetMembers("Deconstruct").OfType[IMethodSymbol]() {
                        if this.TryResolveMigratedProducerDeconstruct(
                            candidate,
                            out var sourceMethod,
                            out var producerCompilation
                        ) {
                            let producerName = EmittedNameAllocator.For(producerCompilation!!).GetName(sourceMethod)
                            if producerName != nil {
                                reserved.Add(producerName)
                            }
                            reserved.Add(this.RecordDeconstructionAdapterName(sourceMethod!!, producerCompilation!!))
                        }
                    }
                }
            }
            if !reserved.Contains(targetAllocated) {
                return targetAllocated
            }
            let taken = HashSet[string](reserved, StringComparer.Ordinal)
            for contractOwner in contractOwners {
                for candidateOwner in ReceiverTypeHierarchy(contractOwner).Concat(contractOwner.AllInterfaces) {
                    for member in candidateOwner.GetMembers() {
                        taken.Add(member.Name)
                    }
                }
            }
            var candidateName = targetAllocated
            for var suffix = 2; taken.Contains(candidateName); suffix++ {
                candidateName = targetAllocated + suffix.ToString(CultureInfo.InvariantCulture)
            }
            return candidateName
        }

        private func TryResolveMigratedProducerDeconstruct(
            method IMethodSymbol?,
            out sourceMethod IMethodSymbol?,
            out producerCompilation Compilation?
        ) bool -> this
            .TryResolveMigratedProducerDeconstructCore(
            method,
            this.context.Compilation,
            HashSet[IMethodSymbol](SymbolEqualityComparer.Default),
            out sourceMethod,
            out producerCompilation
        )

        private func TryResolveMigratedProducerDeconstructCore(
            method IMethodSymbol?,
            owningCompilation Compilation,
            visited HashSet[IMethodSymbol],
            out sourceMethod IMethodSymbol?,
            out producerCompilation Compilation?
        ) bool {
            sourceMethod = nil
            producerCompilation = nil
            if method == nil ||
                (method.Name != "Deconstruct" && !method.Name.EndsWith(".Deconstruct", StringComparison.Ordinal)) ||
                !visited.Add(method.OriginalDefinition) {
                return false
            }
            let compilations = this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            if compilations == nil {
                return false
            }
            let candidates = if method.DeclaringSyntaxReferences.IsDefaultOrEmpty {
                cast[IEnumerable[IMethodSymbol]]([]IMethodSymbol{method})
            } else {
                EmittedNameAllocator
                    .For(owningCompilation)
                    .GetAllDeconstructContractMembers(method)
                    .Where((member IMethodSymbol) -> member.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            }
            for candidate in candidates {
                for source in ObliviousNullabilityAnalyzer.RunSourceDeclarations(
                    candidate.OriginalDefinition,
                    compilations
                )
                    .OfType[IMethodSymbol]() {
                    let producer = compilations.FirstOrDefault(
                        (compilation Compilation) -> compilation
                            .Assembly
                            .Identity
                            .Equals(source.ContainingAssembly.Identity)
                    )
                    if producer == nil {
                        continue
                    }
                    if this.TryResolveMigratedProducerDeconstructCore(
                        source,
                        producer,
                        visited,
                        out var transitiveSource,
                        out var transitiveProducer
                    ) {
                        sourceMethod = transitiveSource
                        producerCompilation = transitiveProducer
                        return true
                    }
                    if EmittedNameAllocator.IsUserRecordDeconstruct(source) || EmittedNameAllocator.For(producer)
                        .HasRenamedDeconstructContract(source) ||
                        (
                        source.IsExtensionMethod &&
                            source.Name == "Deconstruct" &&
                            source.ReturnsVoid &&
                            source
                            .Parameters
                            .Length >= 2 &&
                            this.ExtensionReceiverCanBeRecord(source.Parameters[0].Type)
                    ) {
                        sourceMethod = source
                        producerCompilation = producer
                        return true
                    }
                }
            }
            return false
        }

        private func DeconstructionOutputType(
            info DeconstructionInfo,
            index int32,
            receiverType ITypeSymbol?
        ) ITypeSymbol? {
            if info.Method is IMethodSymbol method {
                let ordinal = index + if method.IsExtensionMethod && method.ReducedFrom == nil {
                    1
                } else {
                    0
                }
                if ordinal < method.Parameters.Length {
                    return method.Parameters[ordinal].Type
                }
            }
            if receiverType is INamedTypeSymbol{IsTupleType: true} tuple && index < tuple.TupleElements.Length {
                return GetEffectiveTupleElementType(tuple, index)
            }
            return nil
        }

        private func DeconstructionOutputSyntax(receiver ExpressionSyntax?, index int32) ExpressionSyntax? {
            return if receiver != nil &&
                Unparenthesize(receiver) is TupleExpressionSyntax tuple &&
                index < tuple
                .Arguments
                .Count {
                tuple.Arguments[index].Expression
            } else {
                nil
            }
        }

        private func MapDeconstructionOutputType(
            info DeconstructionInfo,
            index int32,
            receiverType ITypeSymbol?
        ) GTypeReference? {
            if info.Method is IMethodSymbol method {
                let ordinal = index + if method.IsExtensionMethod && method.ReducedFrom == nil {
                    1
                } else {
                    0
                }
                if ordinal < method.Parameters.Length {
                    return this.MapRecordDeconstructionParameterTypes(method)[ordinal]
                }
            }
            let type = this.DeconstructionOutputType(info, index, receiverType)
            return if type == nil {
                nil
            } else {
                this.typeMapper.Map(type, this.context, location: nil)
            }
        }

        private func GetDeconstructionInfo(right ExpressionSyntax?) DeconstructionInfo ->
        if right?.Parent is AssignmentExpressionSyntax assignment {
            this.context.SemanticModel.GetDeconstructionInfo(assignment)
        } else {
            default(DeconstructionInfo)
        }

        private func NestedDeconstructionInfo(info DeconstructionInfo, index int32) DeconstructionInfo ->
        if index < info.Nested.Length {
            info.Nested[index]
        } else {
            default(DeconstructionInfo)
        }

        private func UserRecordPatternDeconstruct(recursive RecursivePatternSyntax) IMethodSymbol? {
            if recursive.PositionalPatternClause != nil &&
                this
                .context
                .SemanticModel
                .GetOperation(recursive) is IRecursivePatternOperation operation &&
                operation.DeconstructSymbol is IMethodSymbol method &&
                this.UsesRecordDeconstructionAdapter(method, operation.MatchedType) {
                return method
            }
            return nil
        }

        private func RecordDeconstructionRunsUserCode(info DeconstructionInfo, receiverType ITypeSymbol? = nil) bool {
            if this.UsesRecordDeconstructionAdapter(info.Method, receiverType) {
                return true
            }
            if info.Nested.IsDefaultOrEmpty {
                return false
            }
            for var i = 0; i < info.Nested.Length; i++ {
                if this.RecordDeconstructionRunsUserCode(
                    info.Nested[i],
                    this.DeconstructionOutputType(info, i, receiverType)
                ) {
                    return true
                }
            }
            return false
        }

        private func RecordPatternRunsUserCode(pattern PatternSyntax) bool ->
        pattern
            .DescendantNodesAndSelf()
            .OfType[RecursivePatternSyntax]()
            .Any(
            (recursive RecursivePatternSyntax) -> this.UserRecordPatternDeconstruct(recursive) != nil &&
                this.RecordPatternNeedsDeconstruction(recursive)
        )

        private func DecisionSubtreeRunsUserRecordDeconstruct(owner SyntaxNode, pattern PatternSyntax) bool {
            if this.RecordPatternRunsUserCode(pattern) {
                return true
            }
            let path = this.RecordPatternDecisionPath(pattern, owner)
            if path.Length == 0 {
                return false
            }
            return owner
                .DescendantNodes()
                .OfType[RecursivePatternSyntax]()
                .Any(
                (recursive RecursivePatternSyntax) -> object.ReferenceEquals(
                    this.RecordPatternDecisionOwner(recursive),
                    owner
                ) &&
                    this.UserRecordPatternDeconstruct(recursive) != nil && this.RecordPatternNeedsDeconstruction(
                    recursive
                ) &&
                    this
                    .RecordPatternDecisionPath(recursive, owner).StartsWith(path, StringComparison.Ordinal)
            )
        }

        private func TryWrapRecordPatternReceiverCache(
            owner SyntaxNode,
            path string,
            site SyntaxNode,
            memberAccess GExpression,
            memberType ITypeSymbol?,
            buildInner(GExpression) -> GExpression,
            out wrapped GExpression?,
            memberSymbol ISymbol? = nil
        ) bool {
            wrapped = nil
            if memberType == nil || IsTrivialOperand(memberAccess) {
                return false
            }
            let declarations = this.state.ShortCircuitSpillDeclarations ?? this.state.PendingSpillPrologue
            if owner is IsPatternExpressionSyntax && declarations == nil {
                return false
            }
            let canonicalType = this.GetCanonicalPatternMemberStorageType(memberSymbol, memberType) ?? memberType
            if !this.recordPatternReceiverCaches.TryGetValue(owner, out var receiverCaches) {
                receiverCaches = List[(Path string, Flag string, Value string, Type GTypeReference)]()
                this.recordPatternReceiverCaches.Add(owner, receiverCaches)
            }
            var cache = receiverCaches.FirstOrDefault(
                (entry(Path string, Flag string, Value string, Type GTypeReference)) -> entry.Path == path
            )
            if string.IsNullOrEmpty(cache.Flag) {
                let flag = this.AllocateRecordScopedLocalName("hasReceiver", site)
                let value = this.AllocateRecordScopedLocalName("receiver", site)
                var storageType = this.typeMapper.Map(canonicalType, this.context, location: nil)
                if canonicalType.IsReferenceType || this.IsGSharpNullablePatternReceiver(memberAccess) {
                    storageType = MakeNullable(storageType)
                }
                cache = (path, flag, value, storageType!!)
                receiverCaches.Add(cache)
                if owner is IsPatternExpressionSyntax {
                    declarations!!.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    declarations!!.Add(LocalDeclarationStatement(BindingKind.Var, value, storageType))
                }
            }
            let local = IdentifierExpression(cache.Value)
            let flag = IdentifierExpression(cache.Flag)
            if cache.Type.IsNullable {
                this.state.StoredPatternCaptures.Add(local)
            }
            if this.IsGSharpNullablePatternReceiver(memberAccess) ||
                canonicalType.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated {
                this.state.GSharpNullablePatternReceivers.Add(local)
            }
            let innerTest = buildInner(local)
            wrapped = BlockExpression(
                []GStatement{
                    IfStatement(
                        UnaryExpression("!", flag),
                        BlockStatement(
                            []GStatement{
                                AssignmentStatement(local, memberAccess),
                                AssignmentStatement(flag, LiteralExpression.Bool(true))
                            }
                        )
                    )
                },
                innerTest
            )
            return true
        }

        private func TranslateRecordPatternMemberSubpatternTest(
            subPattern PatternSyntax,
            memberAccess GExpression,
            memberType ITypeSymbol?,
            memberSymbol ISymbol? = nil
        ) GExpression {
            if memberType != nil && !IsTrivialOperand(memberAccess) && this.RecordPatternDecisionOwner(
                subPattern
            ) is {} owner &&
                this
                .DecisionSubtreeRunsUserRecordDeconstruct(owner, subPattern) {
                let path = this.RecordPatternDecisionPath(subPattern, owner)
                let canonicalType = this.GetCanonicalPatternMemberStorageType(memberSymbol, memberType) ?? memberType
                let hasCovariantMemberType = !SymbolEqualityComparer.Default.Equals(
                    UnwrapNullablePatternType(canonicalType),
                    UnwrapNullablePatternType(memberType)
                )
                if this.TryWrapRecordPatternReceiverCache(
                    owner,
                    path,
                    subPattern,
                    memberAccess,
                    memberType,
                    (local GExpression) -> {
                        if hasCovariantMemberType &&
                            subPattern is not RecursivePatternSyntax{Type: not nil} &&
                            subPattern is not DeclarationPatternSyntax {
                            let narrowedLocal = ParenthesizedExpression(
                                BinaryExpression(
                                    local,
                                    "as",
                                    TypeExpression(
                                        this.typeMapper.Map(
                                            UnwrapNullablePatternType(memberType),
                                            this.context,
                                            location: nil
                                        )
                                    )
                                )
                            )
                            return this.TranslatePatternTest(
                                narrowedLocal,
                                subPattern,
                                memberType,
                                isNestedPatternMember: true
                            )
                        }
                        return this.TranslatePatternTest(
                            local,
                            subPattern,
                            if hasCovariantMemberType {
                                canonicalType
                            } else {
                                memberType
                            },
                            isNestedPatternMember: true
                        )
                    },
                    out var wrapped,
                    memberSymbol: memberSymbol
                ) {
                    return wrapped!!
                }
            }
            return this.TranslatePatternTest(memberAccess, subPattern, memberType, isNestedPatternMember: true)
        }

        private func RecordPatternOutputIsUnused(pattern PatternSyntax) bool -> switch pattern {
            case _ is DiscardPatternSyntax: true
            case variable is VarPatternSyntax: variable.Designation is DiscardDesignationSyntax
            case parentheses is ParenthesizedPatternSyntax: this.RecordPatternOutputIsUnused(parentheses.Pattern)
            case unary is UnaryPatternSyntax: this.RecordPatternOutputIsUnused(unary.Pattern)
            case binary is BinaryPatternSyntax: this.RecordPatternOutputIsUnused(binary.Left) &&
                this.RecordPatternOutputIsUnused(binary.Right)
            default: false
        }

        private func RecordPatternNeedsDeconstruction(recursive RecursivePatternSyntax) bool ->
        recursive.PositionalPatternClause!!.Subpatterns.Any(
            (subpattern SubpatternSyntax) -> !this.RecordPatternOutputIsUnused(subpattern.Pattern)
        )

        private func GetOrCreateRecordPatternCache(
            owner SyntaxNode,
            path string,
            method IMethodSymbol,
            site RecursivePatternSyntax,
            resultType GTypeReference,
            declarations List[GStatement]?
        )(Path string, Method IMethodSymbol, Flag string, Values string, Type GTypeReference) {
            if !this.recordPatternCaches.TryGetValue(owner, out var caches) {
                caches = List[(Path string, Method IMethodSymbol, Flag string, Values string, Type GTypeReference)]()
                this.recordPatternCaches.Add(owner, caches)
            }
            var cache = caches.FirstOrDefault(
                (entry(Path string, Method IMethodSymbol, Flag string, Values string, Type GTypeReference)) ->
                entry.Path == path && SymbolEqualityComparer.Default.Equals(entry.Method, method)
            )
            if cache.Method == nil {
                let flag = this.AllocateRecordScopedLocalName("deconstructed", site)
                let values = this.AllocateRecordScopedLocalName("components", site)
                cache = (path, method, flag, values, resultType)
                caches.Add(cache)
                if owner is IsPatternExpressionSyntax && declarations != nil {
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    declarations.Add(LocalDeclarationStatement(BindingKind.Var, values, resultType))
                }
            }
            return cache
        }

        private func TranslateRecordPositionalPatternTest(
            receiver GExpression?,
            recursive RecursivePatternSyntax,
            method IMethodSymbol
        ) GExpression {
            let subpatterns = recursive.PositionalPatternClause!!.Subpatterns
            // C# omits a pattern's Deconstruct call when every output is discarded.
            if !this.RecordPatternNeedsDeconstruction(recursive) {
                var test GExpression = LiteralExpression.Bool(true)
                for subpattern in subpatterns {
                    test = BinaryExpression(
                        test,
                        "&&",
                        this.TranslatePatternTest(LiteralExpression.Int("0"), subpattern.Pattern)
                    )
                }
                return test
            }
            let owner = this.RecordPatternDecisionOwner(recursive)
            let matchedType = if this
                .context
                .SemanticModel
                .GetOperation(recursive) is IRecursivePatternOperation operation {
                operation.MatchedType
            } else {
                default(ITypeSymbol?)
            }
            let call = this.RewriteRecordDeconstruction(receiver, method, recursive, actualReceiverType: matchedType)
            let outputTypes = this.MapRecordDeconstructionOutputParameterTypes(method)
            let outputParameters = this.GetDeconstructOutputParameters(method)
            let resultType = this.RecordDeconstructionResultType(method, outputTypes)
            let BuildTest = func (tuple GExpression) GExpression {
                var test GExpression = LiteralExpression.Bool(true)
                for var i = 0; i < subpatterns.Count; i++ {
                    if subpatterns[i].Pattern is DiscardPatternSyntax or
                        VarPatternSyntax{Designation: DiscardDesignationSyntax} {
                        continue
                    }
                    var member GExpression = if subpatterns.Count == 1 {
                        tuple
                    } else {
                        MemberAccessExpression(tuple, "Item" + (i + 1).ToString(CultureInfo.InvariantCulture))
                    }
                    if subpatterns.Count > 1 && IsPointerOrFunctionPointerType(outputParameters[i].Type) {
                        member = ConversionExpression(outputTypes[i], member, isCheckedReferenceCast: true)
                    }
                    if outputTypes[i].IsNullable {
                        this.state.GSharpNullablePatternReceivers.Add(member)
                    }
                    let component = this.TranslatePatternTest(
                        member,
                        subpatterns[i].Pattern,
                        outputParameters[i].Type,
                        isNestedPatternMember: true
                    )
                    test = BinaryExpression(test, "&&", component)
                }
                return test
            }
            let declarations = this.state.ShortCircuitSpillDeclarations ?? this.state.PendingSpillPrologue
            if owner != nil && (owner is not IsPatternExpressionSyntax || declarations != nil) {
                let path = this.RecordPatternDecisionPath(recursive, owner)
                let cache = this.GetOrCreateRecordPatternCache(owner, path, method, recursive, resultType, declarations)
                let local = IdentifierExpression(cache.Values)
                let flag = IdentifierExpression(cache.Flag)
                return BlockExpression(
                    []GStatement{
                        IfStatement(
                            UnaryExpression("!", flag),
                            BlockStatement(
                                []GStatement{
                                    AssignmentStatement(local, call),
                                    AssignmentStatement(flag, LiteralExpression.Bool(true))
                                }
                            )
                        )
                    },
                    BuildTest(local)
                )
            }
            if !subpatterns.Any((subpattern SubpatternSyntax) -> PatternIntroducesBinding(subpattern.Pattern)) {
                return this.BindPatternMemberOnce(
                    call,
                    BuildTest,
                    this.AllocateRecordScopedLocalName("components", recursive)
                )
            }
            if declarations == nil {
                this.context.ReportUnsupported(
                    recursive,
                    "record positional pattern bindings require a declaration seam."
                )
                return LiteralExpression.Bool(false)
            }
            // Store the outputs inside the guarded test so bindings read them without repeating the call.
            let symbolType = if outputParameters.Count == 1 {
                outputParameters[0].Type
            } else {
                this
                    .context
                    .Compilation
                    .CreateTupleTypeSymbol(
                    outputParameters.Select(
                        (parameter IParameterSymbol) -> if this.IsPointerOrFunctionPointerType(parameter.Type) {
                            cast[ITypeSymbol](this.context.Compilation.GetSpecialType(SpecialType.System_UIntPtr))
                        } else {
                            parameter.Type
                        }
                    )
                        .ToImmutableArray()
                )
            }
            return this.StorePatternMemberOnce(call, symbolType, false, declarations, BuildTest, resultType)
        }

        private func RecordPatternDecisionOwner(node SyntaxNode) SyntaxNode? {
            var pattern SyntaxNode = node
            while pattern.Parent is PatternSyntax or
                SubpatternSyntax or
                PropertyPatternClauseSyntax or
                PositionalPatternClauseSyntax {
                pattern = pattern.Parent!!
            }
            return switch pattern.Parent {
                case arm is SwitchExpressionArmSyntax when arm.Pattern == pattern: arm.Parent
                case label is CasePatternSwitchLabelSyntax when label.Pattern == pattern: label.Parent?.Parent
                case expression is IsPatternExpressionSyntax when expression.Pattern == pattern: expression
                default: nil
            }
        }

        private func GetCanonicalPatternMemberStorageType(symbol ISymbol?, fallbackType ITypeSymbol?) ITypeSymbol? {
            if symbol == nil {
                return fallbackType
            }
            var current ISymbol = symbol
            while true {
                switch current {
                    case property is IPropertySymbol when property.OverriddenProperty != nil {
                        current = property.OverriddenProperty!!
                        continue
                    }
                    case method is IMethodSymbol when method.OverriddenMethod != nil {
                        current = method.OverriddenMethod!!
                        continue
                    }
                }
                break
            }
            return switch current {
                case property is IPropertySymbol: property.Type
                case field is IFieldSymbol: field.Type
                case method is IMethodSymbol: method.ReturnType
                default: fallbackType
            }
        }

        private func GetCanonicalPatternMemberSlotKey(symbol ISymbol?) string {
            if symbol == nil {
                return "?"
            }
            var current ISymbol = symbol
            while true {
                switch current {
                    case property is IPropertySymbol when property.OverriddenProperty != nil {
                        current = property.OverriddenProperty!!
                        continue
                    }
                    case method is IMethodSymbol when method.OverriddenMethod != nil {
                        current = method.OverriddenMethod!!
                        continue
                    }
                }
                break
            }
            return current.ToDisplayString()
        }

        private func SplitPatternMemberPathKeys(memberPath ExpressionSyntax) List[string] {
            let keys = List[string]()
            var current = memberPath
            while current is MemberAccessExpressionSyntax memberAccess {
                let symbol = this.GetPatternMemberSymbol(memberAccess)
                keys.Insert(
                    0,
                    if symbol != nil {
                        this.GetCanonicalPatternMemberSlotKey(symbol)
                    } else {
                        this.GetPatternMemberName(memberAccess.Name) ?? "?"
                    }
                )
                current = memberAccess.Expression
            }
            let rootSymbol = this.GetPatternMemberSymbol(current)
            keys.Insert(
                0,
                if rootSymbol != nil {
                    this.GetCanonicalPatternMemberSlotKey(rootSymbol)
                } else {
                    current.ToString()
                }
            )
            return keys
        }

        private func RecordPatternDecisionPath(node SyntaxNode, owner SyntaxNode) string {
            let steps = List[string]()
            var current SyntaxNode? = node
            while current != nil && !object.ReferenceEquals(current, owner) {
                switch current {
                    case subpattern is SubpatternSyntax when subpattern.Parent is PropertyPatternClauseSyntax {
                        let step = if subpattern.NameColon != nil {
                            let memberSymbol = this.GetPatternMemberSymbol(subpattern.NameColon!!.Name)
                            "prop:" + if memberSymbol != nil {
                                this.GetCanonicalPatternMemberSlotKey(memberSymbol)
                            } else {
                                this.GetSubpatternMemberName(subpattern)
                            }
                        } else if subpattern.ExpressionColon != nil {
                            "prop:" + string.Join(
                                "/prop:",
                                this.SplitPatternMemberPathKeys(subpattern.ExpressionColon!!.Expression)
                            )
                        } else {
                            "prop:?"
                        }
                        steps.Insert(0, step)
                    }
                    case subpattern is SubpatternSyntax when subpattern.Parent is PositionalPatternClauseSyntax clause {
                        let index = clause.Subpatterns.IndexOf(subpattern)
                        var producerKey = ""
                        if clause.Parent is RecursivePatternSyntax parentRecursive {
                            if this
                                .context
                                .SemanticModel
                                .GetOperation(parentRecursive) is IRecursivePatternOperation parentOperation {
                                if parentOperation.DeconstructSymbol is IMethodSymbol deconstructMethod {
                                    producerKey = this.GetCanonicalPatternMemberSlotKey(deconstructMethod)
                                } else if parentOperation.MatchedType != nil {
                                    producerKey = parentOperation.MatchedType.ToDisplayString()
                                }
                            } else if parentRecursive.Type != nil {
                                producerKey = this
                                    .context
                                    .GetTypeInfo(parentRecursive.Type)
                                    .Type
                                    ?.ToDisplayString() ??
                                    ""
                            }
                        }
                        steps.Insert(0, "pos:" + producerKey + "#" + index.ToString(CultureInfo.InvariantCulture))
                    }
                    case slice is SlicePatternSyntax when slice.Parent is ListPatternSyntax list {
                        let sliceIndex = list.Patterns.IndexOf(slice)
                        let suffixCount = list.Patterns.Count - sliceIndex - 1
                        let listOp = this.context.SemanticModel.GetOperation(list) as IListPatternOperation
                        let sliceOp = this.context.SemanticModel.GetOperation(slice) as ISlicePatternOperation
                        let sliceKey = this.GetCanonicalPatternMemberSlotKey(
                            sliceOp?.SliceSymbol ?? listOp?.IndexerSymbol
                        )
                        let lengthKey = this.GetCanonicalPatternMemberSlotKey(listOp?.LengthSymbol)
                        steps.Insert(
                            0,
                            "slice:" + sliceKey + ":" + lengthKey + ":" + sliceIndex.ToString(
                                CultureInfo.InvariantCulture
                            ) +
                                ":^" +
                                suffixCount.ToString(CultureInfo.InvariantCulture)
                        )
                    }
                    case pattern is PatternSyntax when pattern.Parent is ListPatternSyntax list {
                        let index = list.Patterns.IndexOf(pattern)
                        let sliceIndex = FindSlicePatternIndex(list.Patterns)
                        let listOp = this.context.SemanticModel.GetOperation(list) as IListPatternOperation
                        let indexerKey = this.GetCanonicalPatternMemberSlotKey(listOp?.IndexerSymbol)
                        if sliceIndex >= 0 && index > sliceIndex {
                            let fromEnd = list.Patterns.Count - index
                            let lengthKey = this.GetCanonicalPatternMemberSlotKey(listOp?.LengthSymbol)
                            steps.Insert(
                                0,
                                "list:" + indexerKey + ":" + lengthKey + ":^" + fromEnd.ToString(
                                    CultureInfo.InvariantCulture
                                )
                            )
                        } else {
                            steps.Insert(0, "list:" + indexerKey + ":" + index.ToString(CultureInfo.InvariantCulture))
                        }
                    }
                }
                current = current.Parent
            }
            return string.Join("/", steps)
        }

        private func ResetRecordPatternCaches(owner SyntaxNode, subject GExpression?) GExpression? {
            let resets = this.RecordPatternCacheResets(owner)
            return if resets.Count == 0 {
                subject
            } else {
                BlockExpression(resets, subject)
            }
        }

        private func RecordPatternCacheResets(owner SyntaxNode) List[GStatement] {
            let resets = List[GStatement]()
            if this.recordPatternTypeGuards.TryGetValue(owner, out var typeGuards) {
                for guard_ in typeGuards {
                    resets.Add(AssignmentStatement(IdentifierExpression(guard_.Flag), LiteralExpression.Bool(false)))
                }
            }
            if this.recordPatternReceiverCaches.TryGetValue(owner, out var receiverCaches) {
                for cache in receiverCaches {
                    resets.Add(AssignmentStatement(IdentifierExpression(cache.Flag), LiteralExpression.Bool(false)))
                }
            }
            if this.recordPatternCaches.TryGetValue(owner, out var caches) {
                for cache in caches {
                    resets.Add(AssignmentStatement(IdentifierExpression(cache.Flag), LiteralExpression.Bool(false)))
                }
            }
            return resets
        }

        private func RecordPatternCacheDeclarations(owner SyntaxNode) List[GStatement] {
            let declarations = List[GStatement]()
            if this.recordPatternTypeGuards.TryGetValue(owner, out var typeGuards) {
                for guard_ in typeGuards {
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            guard_.Flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    if guard_.Value != nil {
                        declarations.Add(LocalDeclarationStatement(BindingKind.Var, guard_.Value!!, guard_.StorageType))
                    }
                }
            }
            if this.recordPatternReceiverCaches.TryGetValue(owner, out var receiverCaches) {
                for cache in receiverCaches {
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            cache.Flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    declarations.Add(LocalDeclarationStatement(BindingKind.Var, cache.Value, cache.Type))
                }
            }
            if this.recordPatternCaches.TryGetValue(owner, out var caches) {
                for cache in caches {
                    declarations.Add(
                        LocalDeclarationStatement(
                            BindingKind.Var,
                            cache.Flag,
                            NamedTypeReference("bool"),
                            LiteralExpression.Bool(false)
                        )
                    )
                    declarations.Add(LocalDeclarationStatement(BindingKind.Var, cache.Values, cache.Type))
                }
            }
            return declarations
        }

        private func WrapRecordPatternDecision(owner SyntaxNode, expression GExpression?) GExpression? {
            let declarations = this.RecordPatternCacheDeclarations(owner)
            return if declarations.Count == 0 {
                expression
            } else {
                BlockExpression(declarations, expression)
            }
        }

        private func TranslateRecordRecursivePattern(
            recursive RecursivePatternSyntax,
            receiver GExpression?,
            bindings List[(Symbol ISymbol, Replacement GExpression)],
            usedDesignators HashSet[string]?,
            guards List[GExpression],
            mutableBindings List[(Symbol ILocalSymbol, MatchedValue GExpression)]?
        ) GPattern {
            let operation = cast[IRecursivePatternOperation](this.context.SemanticModel.GetOperation(recursive))
            let designator = if recursive.Designation is SingleVariableDesignationSyntax variable {
                this.EmittedName(variable, variable.Identifier)!!
            } else {
                this.AllocateRecordScopedLocalName("record", recursive)
            }
            usedDesignators?.Add(designator)
            this.AddTypedSubpatternGuard(
                () -> this.TranslateRecursivePatternTest(
                    IdentifierExpression(designator),
                    recursive,
                    receiverType: operation.MatchedType,
                    receiverAlreadyMatched: true
                ),
                bindings,
                guards,
                mutableBindings
            )
            return TypePattern(
                designator,
                this.typeMapper.Map(operation.MatchedType, this.context, location: nil)!!,
                designationAfterType: true
            )
        }

        /// Hosts value-position deconstruction assignments, the lone assignment
        /// shape without a native G# expression form. Ordinary and compound
        /// assignments remain in place as ADR-0161 assignment expressions.
        private func WithHoistedAssignments(
            expression ExpressionSyntax?,
            includeSelf bool,
            buildMain() -> List[GStatement]
        ) IEnumerable[GStatement] {
            let hoisted = List[GStatement]()
            let replacements = List[ExpressionSyntax]()
            let suppressed = this.HoistAssignmentsInOrder(expression, includeSelf, hoisted, replacements)
            if suppressed.Count == 0 {
                return buildMain()
            }
            try {
                hoisted.AddRange(buildMain())
                return hoisted
            } finally {
                this.ReleaseHoistedAssignments(suppressed, replacements)
            }
        }

        private func HoistAssignmentsInOrder(
            expression ExpressionSyntax?,
            includeSelf bool,
            statements List[GStatement],
            replacements List[ExpressionSyntax]
        ) List[AssignmentExpressionSyntax] {
            let embedded = this.CollectEmbeddedAssignments(expression, includeSelf)
            for node in embedded {
                this.HoistPrecedingEvaluationOperands(expression, node, statements, replacements)
                statements.AddRange(this.FlattenChainedAssignment(node))
                this.state.SuppressedAssignments.Add(node)
            }
            return embedded
        }

        private func ReleaseHoistedAssignments(
            suppressed IEnumerable[AssignmentExpressionSyntax],
            replacements IEnumerable[ExpressionSyntax]
        ) {
            for node in suppressed {
                this.state.SuppressedAssignments.Remove(node)
            }
            for replacement in replacements {
                this.state.HoistedExpressionValues.Remove(replacement)
            }
        }

        private func RequiresLocalAssignmentSeam(expression ExpressionSyntax) bool -> this.CollectEmbeddedAssignments(
            expression,
            includeSelf: true
        )
            .Count > 0

        private func TranslateWithLocalAssignmentSeam(
            expression ExpressionSyntax,
            translate() -> GExpression
        ) GExpression {
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let statements = List[GStatement]()
            let replacements = List[ExpressionSyntax]()
            this.state.PendingSpillPrologue = statements
            let embedded = this.HoistAssignmentsInOrder(expression, includeSelf: true, statements, replacements)
            try {
                let value = translate()
                return if statements.Count == 0 {
                    value
                } else {
                    cast[GExpression](BlockExpression(statements, value))
                }
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        private func HoistPrecedingEvaluationOperands(
            root ExpressionSyntax?,
            assignment AssignmentExpressionSyntax,
            statements List[GStatement],
            replacements List[ExpressionSyntax]
        ) {
            var current IOperation? = this.context.SemanticModel.GetOperation(assignment)
            if current == nil {
                return
            }
            let groups = List[List[ExpressionSyntax]]()
            while current.Parent is IOperation parent && current.Syntax != root {
                let preceding = List[ExpressionSyntax]()
                for child in parent.ChildOperations {
                    if object.ReferenceEquals(child, current) {
                        break
                    }
                    let expression ExpressionSyntax? = OperationExpression(child)
                    if expression != nil && root!!.Span.Contains(expression.Span) && expression != root {
                        preceding.Add(expression)
                    }
                }
                if preceding.Count > 0 {
                    groups.Insert(0, preceding)
                }
                current = parent
            }
            for preceding in groups.SelectMany(
                func (group List[ExpressionSyntax]) IEnumerable[ExpressionSyntax] {
                    return group
                }
            ) {
                if this
                    .state
                    .HoistedExpressionValues
                    .ContainsKey(preceding) ||
                    preceding is LiteralExpressionSyntax ||
                    preceding is ThisExpressionSyntax ||
                    preceding is BaseExpressionSyntax ||
                    preceding is DefaultExpressionSyntax ||
                    preceding is TypeOfExpressionSyntax {
                    continue
                }
                let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
                this.state.PendingSpillPrologue = statements
                var value GExpression?
                try {
                    value = this.TranslateExpression(preceding)
                } finally {
                    this.state.PendingSpillPrologue = outerSpillPrologue
                }
                let temp = this.NewSpillName()
                statements.Add(LocalDeclarationStatement(BindingKind.Let, temp, type: nil, initializer: value))
                this.state.HoistedExpressionValues[preceding] = IdentifierExpression(temp)
                replacements.Add(preceding)
            }
        }

        /// Translates a condition while redirecting any spill or embedded
        /// deconstruction-assignment statements into [`prologue`](paramref).
        private func TranslateConditionWithHoist(expression ExpressionSyntax, prologue List[GStatement]) GExpression? {
            // Any spill hoisted while translating `expression` (issue #1731) is
            // redirected into `prologue` — the SAME preceding-statement list an
            // embedded deconstruction assignment uses — rather than the enclosing
            // statement's own ambient prologue, so both kinds of hoist land in
            // the same list in evaluation order.
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            this.state.PendingSpillPrologue = prologue
            try {
                return this.TranslateConditionWithHoistCore(expression, prologue)
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
            }
        }

        private func TranslateConditionWithHoistCore(
            expression ExpressionSyntax,
            prologue List[GStatement]
        ) GExpression? {
            let replacements = List[ExpressionSyntax]()
            let embedded = this.HoistAssignmentsInOrder(expression, includeSelf: true, prologue, replacements)
            try {
                return this.TranslateExpression(expression)
            } finally {
                this.ReleaseHoistedAssignments(embedded, replacements)
            }
        }

        /// Finds value-position deconstruction-assignment nodes in
        /// [`expression`](paramref) (in evaluation/document order),
        /// excluding ones inside a nested lambda/local function (their own
        /// statement seam). Assignments inside a conditional
        /// (`?:`) arm are left for that arm's native G# block-expression seam.
        /// Assignments inside any other short-circuited operand are left for that
        /// operand's local block-expression seam.
        private func CollectEmbeddedAssignments(expression ExpressionSyntax?, includeSelf bool) List[
            AssignmentExpressionSyntax
        ] {
            // Issue #1892: an object/`with` initializer's `Field = value`
            // elements (InitializerExpressionSyntax children of kind
            // ObjectInitializerExpression/WithInitializerExpression) are
            // AssignmentExpressionSyntax nodes syntactically, but they are
            // composite-literal/with-expression MEMBERS, not real value-position
            // assignments — collecting the member assignment itself would hoist
            // every initializer member into a stray bare `Field = value;`
            // statement in front of the (correct) literal/with-expression that
            // already carries it. Array/collection initializer elements
            // (ArrayInitializerExpression/CollectionInitializerExpression), by
            // contrast, are plain VALUES — an `AssignmentExpressionSyntax`
            // element there (`new[] { x = 5 }`) is a genuine value-position
            // assignment and must still be collected.
            //
            // Issue #1947: even for a skipped member-assignment, its VALUE may
            // itself embed a genuine value-position assignment
            // (`new T { A = (x = 3) }`) — that must still be found/hoisted, so
            // the member assignment's Right is scanned rather than skipped
            // wholesale.
            let IsInitializerMember = func (assignment AssignmentExpressionSyntax) bool {
                return assignment.Parent is InitializerExpressionSyntax initializer &&
                    (
                    initializer.IsKind(SyntaxKind.ObjectInitializerExpression) || initializer.IsKind(
                        SyntaxKind.WithInitializerExpression
                    )
                )
            }
            let Scan = func (node SyntaxNode?) IEnumerable[AssignmentExpressionSyntax] {
                if node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax {
                    yield break
                }
                // Issue #3348: a query CLAUSE's expression is translated inside the
                // lambda that clause lowers to (see <see cref="BuildScopeLambda"/> /
                // <see cref="LowerLetClause"/>) — its own evaluation scope, exactly
                // like an explicit lambda's, even though it is not an
                // `AnonymousFunctionExpressionSyntax` syntactically. Hoisting an
                // assignment out of one would move the write into the ENCLOSING
                // statement, where the range variable it reads is not in scope at
                // all, and would run it once for the whole query instead of once per
                // element. Only the sub-expressions a query evaluates EAGERLY, in the
                // enclosing scope, are scanned here: the source of the first `from`,
                // and each `join`'s `in` source (C# forbids either from referencing a
                // range variable, so neither can capture one). Every clause body is
                // left to its own lambda's seam, which hoists into the lambda.
                if node is QueryExpressionSyntax query {
                    for eager in EagerQuerySources(query) {
                        for found in Scan(eager) {
                            yield found
                        }
                    }
                    yield break
                }
                if node is AssignmentExpressionSyntax assignment {
                    if IsInitializerMember(assignment) {
                        for found in Scan(assignment.Right) {
                            yield found
                        }
                        yield break
                    }
                    // ADR-0161 / issue #3347: ordinary assignment expressions,
                    // including `??=`, stay where C# put them. Only
                    // deconstruction still requires statement-hosting fallback.
                    if AssignmentRequiresStatementLowering(assignment) {
                        yield assignment
                        yield break
                    }
                    for child in assignment.ChildNodes() {
                        for found in Scan(child) {
                            yield found
                        }
                    }
                    yield break
                }
                for child in node!!.ChildNodes() {
                    for found in Scan(child) {
                        yield found
                    }
                }
            }
            let candidates = if includeSelf || expression is not AssignmentExpressionSyntax rootAssignment {
                Scan(expression)
            } else {
                Scan(rootAssignment.Left).Concat(Scan(rootAssignment.Right))
            }
            let safe = List[AssignmentExpressionSyntax]()
            for candidate in candidates {
                if IsInsideConditionalValueBranch(candidate, expression) {
                    continue
                }
                if IsInShortCircuitedSubexpression(candidate, expression) {
                    // Scalar assignments remain native G# value expressions.
                    // Deconstruction is hosted by the nested short-circuit
                    // operand's own block-expression seam.
                    continue
                }
                safe.Add(candidate)
            }
            return safe
        }

        private func FlattenChainedAssignment(
            assignment AssignmentExpressionSyntax,
            preserveValue bool = true
        ) IEnumerable[GStatement] {
            // Follows the chain through ANY assignment operator (`=`, `+=`, …), not
            // just `=`: `a = b += c` is `a = (b += c)`, so the `+=` link must also be
            // captured or its mutation of `b` is silently dropped (issue #1723). The
            // walk is parenthesis-transparent (`a = (b = c)`) since a link's RHS may
            // be a parenthesized nested assignment.
            let lefts = List[(Target GExpression?, Op string, Syntax ExpressionSyntax)]()
            var current ExpressionSyntax = assignment
            var tupleLink TupleExpressionSyntax? = nil
            var tupleLinkRight ExpressionSyntax? = nil
            while true {
                var unwrapped = current
                while unwrapped is ParenthesizedExpressionSyntax paren {
                    unwrapped = paren.Expression
                }
                if unwrapped is not AssignmentExpressionSyntax link {
                    break
                }
                if link.Left is TupleExpressionSyntax linkTuple {
                    // A deconstruction-assignment link (`(a, b) = ...`) used in
                    // value position, either standalone (`var r = ((x, y) = (1,
                    // 2));`) or feeding an outer chain (`x = (a, b) = (1, 2);`).
                    // It has no single further "target" of its own, so the
                    // chain walk ends here (issue #1974).
                    tupleLink = linkTuple
                    tupleLinkRight = link.Right
                    break
                }
                lefts.Add((this.TranslateExpression(link.Left), link.OperatorToken.Text, link.Left))
                current = link.Right
            }
            let statements = List[GStatement]()
            // C# evaluates every target's receiver/index sub-expression
            // left-to-right — outermost first, matching source order — BEFORE
            // the shared RHS is evaluated (`a[F()] = b[G()] = c` runs F() then
            // G() then c). Spill each target's side-effecting parts here, in
            // that order; a target that is already an identifier/`this`/field
            // with no side-effecting sub-part passes through untouched.
            let safeTargets = [lefts.Count]GExpression
            for var i = 0; i < lefts.Count; i++ {
                safeTargets[i] = this.MakeDuplicationSafeTarget(lefts[i].Target!!, statements, lefts[i].Syntax)
            }
            var value GExpression?
            if tupleLink != nil {
                // A non-identifier target (`arr[i]`, `obj.F`, ...) anywhere in the
                // (possibly nested) target shape is handled by
                // `LowerTupleAssignmentForValue` capturing its receiver/index
                // FIRST, before the RHS is spilled (issue #2234, generalizing
                // #1895/#1974).
                let (tupleStatements, tupleValue) = this.LowerTupleAssignmentForValue(tupleLink, tupleLinkRight)
                statements.AddRange(tupleStatements)
                value = tupleValue
            } else {
                value = this.TranslateExpression(current)
            }
            // Walk the chain innermost-out, assigning to each target in turn.
            // C# assigns the SAME rhs VALUE to every target in a run of plain
            // `=` links — it never re-reads an inner target's getter to obtain
            // the value carried to the next (outer) link (issue #1845): `a =
            // obj.P = c` calls `P`'s setter once and never its getter. A
            // compound link (`+=`, …) genuinely produces a NEW value — the
            // target's old value combined with the operand — so its result
            // still has to be read back for the next link; that read is real
            // C# semantics, unrelated to the #1845 divergence, and is left as
            // it was under the #1731/#1842 fix (the target was already made
            // safe to re-embed above). This fallback is now reached only by a
            // chain containing a tuple-valued link, which has no native
            // assignment-expression form. Re-embedding a compound target
            // expression as-is would re-read its
            // getter once per outer link (issue #1875) — instead of doing
            // that, the read/combine/store is expanded manually (mirroring
            // exactly what the compound operator does) so the combined value
            // is captured directly, with no re-read at all.
            var valueIsShared = false
            for var i = lefts.Count - 1; i >= 0; i-- {
                let hasOuterLink = i > 0
                let targetNeedsCapturedValue = this.AssignmentTargetNeedsCapturedValue(lefts[i].Syntax)
                let captureRootSimpleValue = preserveValue && i == 0 && assignment.IsKind(
                    SyntaxKind.SimpleAssignmentExpression
                ) &&
                    targetNeedsCapturedValue
                let compoundBinaryOp string? = if lefts[i].Op == "=" {
                    default(string?)
                } else {
                    CompoundToBinaryOperator(lefts[i].Op)
                }
                let captureRootCompoundValue = preserveValue &&
                    i == 0 &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp != nil
                var assignedValue GExpression? = value
                if lefts[i].Op == "=" {
                    let target ISymbol? = this.context.GetSymbolInfo(lefts[i].Syntax).Symbol
                    var targetType ITypeSymbol? = switch target {
                        case local is ILocalSymbol: local.Type
                        case parameter is IParameterSymbol: parameter.Type
                        case field is IFieldSymbol: field.Type
                        case property is IPropertySymbol: property.Type
                        default: this.context.GetTypeInfo(lefts[i].Syntax).Type
                    }
                    var promotionTarget ISymbol? = target
                    if this.LocalStoreAcceptsNil(target) {
                        targetType = targetType?.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.Annotated
                        )
                    } else if target is ILocalSymbol inferredLocal &&
                        inferredLocal
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.GetSyntax() is VariableDeclaratorSyntax{Initializer: {Value: {} initializer}} declarator &&
                        declarator
                        .Ancestors()
                        .OfType[VariableDeclarationSyntax]()
                        .FirstOrDefault()
                        ?.Type
                        .IsVar == true {
                        targetType = this.context.GetTypeInfo(initializer).Type
                        promotionTarget = nil
                    }
                    assignedValue = this.ForgiveNullableReferenceValue(
                        current,
                        assignedValue,
                        targetType,
                        promotionTarget,
                        includePromotedValue: true
                    )
                }
                if captureRootSimpleValue {
                    // C# yields the converted RHS, never a post-set target read.
                    // A typed temp preserves that value for properties, set-only
                    // storage, and targets whose receiver/index had to be spilled.
                    assignedValue = this.CaptureAssignmentValue(assignment, assignedValue, statements)
                } else if hasOuterLink && lefts[i].Op == "=" && !valueIsShared {
                    // About to be assigned to more than one target — spill once
                    // so the RHS expression is evaluated exactly one time, then
                    // every remaining target reuses the same temp/trivial value.
                    assignedValue = this.SpillOperand(value!!, statements)
                    value = assignedValue
                    valueIsShared = true
                }
                if (hasOuterLink || captureRootCompoundValue) &&
                    targetNeedsCapturedValue &&
                    compoundBinaryOp is string binaryOp {
                    // A non-trivial compound target must yield its computed value
                    // without re-reading the getter: both an outer assignment chain
                    // (`a = c.P += d`, issue #1875) and a standalone value position
                    // (`Echo(c.P += d)`) reuse the captured combined value.
                    let oldValue GExpression? = this.SpillOperand(safeTargets[i], statements)
                    let combinedValue GExpression = BinaryExpression(oldValue, binaryOp, assignedValue)
                    let newValue GExpression? = if captureRootCompoundValue {
                        this.CaptureAssignmentValue(assignment, combinedValue, statements)
                    } else {
                        this.SpillOperand(combinedValue, statements)
                    }
                    statements.Add(AssignmentStatement(safeTargets[i], newValue, "="))
                    value = newValue
                    valueIsShared = true
                    continue
                }
                statements.Add(AssignmentStatement(safeTargets[i], assignedValue, lefts[i].Op))
                if hasOuterLink && lefts[i].Op != "=" {
                    // Trivial target (bare local/`this`): reading it back has
                    // no getter to worry about, so it stays the simple
                    // read-back this fix has always used for compound links.
                    // `??=` also lands here regardless of target triviality —
                    // it has no side-effect-free binary-expression equivalent
                    // (it must only evaluate/store the right-hand side when
                    // the target is null) — so a non-trivial `??=` target
                    // costs one extra getter call total (not one per outer
                    // link), the minimum faithful cost without reimplementing
                    // its short-circuit semantics.
                    value = if IsTrivialOperand(safeTargets[i]) {
                        safeTargets[i]
                    } else {
                        this.SpillOperand(safeTargets[i], statements)
                    }
                    valueIsShared = true
                }
            }
            return statements
        }

        private func CaptureAssignmentValue(
            assignment AssignmentExpressionSyntax,
            value GExpression?,
            statements List[GStatement]
        ) GExpression {
            let temp = this.NewSpillName()
            statements.Add(
                LocalDeclarationStatement(BindingKind.Let, temp, this.ResolveExpressionType(assignment), value)
            )
            let captured = IdentifierExpression(temp)
            this.state.AssignmentValues[assignment] = captured
            return captured
        }

        private func AssignmentTargetNeedsCapturedValue(target ExpressionSyntax) bool {
            if this.context.GetSymbolInfo(target).Symbol is IPropertySymbol {
                return true
            }
            return !(target is IdentifierNameSyntax)
        }

        // True when a discard element — either the bare-assignment form
        // (`(x, _) = ...`) or the declaration form (`(x, var _) = ...`,
        // parsed as a `DeclarationExpressionSyntax` wrapping a
        // `DiscardDesignationSyntax`).
        private func IsDeconstructionDiscard(targetExpr ExpressionSyntax) bool -> (
            targetExpr is IdentifierNameSyntax discardCandidate &&
                discardCandidate
                .Identifier
                .ValueText == "_" &&
                this.IsTrueDiscard(discardCandidate)
        ) ||
            targetExpr is DeclarationExpressionSyntax &&
            targetExpr.Designation is DiscardDesignationSyntax

        // True when every immediate element is a discard. A nested tuple must
        // recurse because its corresponding value may use a custom Deconstruct.
        private func HasOnlyImmediateDiscards(pattern TupleExpressionSyntax) bool {
            for argument in pattern.Arguments {
                if !this.IsDeconstructionDiscard(argument.Expression) {
                    return false
                }
            }
            return true
        }

        // Statement-position deconstruction assignment (`(a, b) = (x, y);`):
        // the resulting per-element values are never read back, so discards
        // stay true discards (no temp allocated for them).
        private func LowerTupleAssignment(leftTuple TupleExpressionSyntax, right ExpressionSyntax) IEnumerable[
            GStatement
        ]? {
            // Issues #3353/#3358: G#'s native multi-target assignment now
            // accepts storage targets and a tuple-valued single RHS while
            // preserving C#'s targets-then-RHS-then-writes order.
            if this.TryLowerNativeMultiAssignment(leftTuple, right, out var native) {
                return native
            }
            let statements = List[GStatement]()
            let captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements)
            this.LowerTuplePattern(
                leftTuple,
                this.TranslateExpression(right),
                forceRealTemps: false,
                statements,
                captured,
                this.GetDeconstructionInfo(right),
                this.context.GetTypeInfo(right).Type as INamedTypeSymbol,
                receiverSyntax: right
            )
            return statements
        }

        /// Issue #3358: renders a C# deconstruction assignment as G#'s native
        /// multi-target assignment (`a, b = b, a`, ADR-0015) when every part
        /// of the shape is expressible, replacing a temporary tuple binding
        /// plus per-target-write triple.
        /// @remarks ADR-0015 evaluates every right-hand expression left-to-right into
        /// temporaries before any write, then assigns left-to-right — exactly the
        /// order C# specifies, so aliasing swaps and storage targets stay correct.
        ///
        /// Mixed fresh/existing targets use ADR-0168 inline bindings. Nested
        /// target tuples keep the existing lowering. Non-tuple deconstruction
        /// sources also keep it because native multi-assignment unifies tuple
        /// values only.
        /// @param leftTuple The C# deconstruction target tuple.
        /// @param right The right-hand side.
        /// @param result The emitted statements when the rewrite applies.
        /// @returns `true` when the rewrite applied.
        private func TryLowerNativeMultiAssignment(
            leftTuple TupleExpressionSyntax,
            right ExpressionSyntax,
            out result IReadOnlyList[GStatement]?
        ) bool {
            result = nil
            let rightTypeInfo = this.context.GetTypeInfo(right)
            let rightTypeSymbol = rightTypeInfo.Type ?? rightTypeInfo.ConvertedType
            if rightTypeSymbol is not INamedTypeSymbol rightType ||
                !rightType.IsTupleType ||
                rightType
                .TupleElements
                .Length != leftTuple
                .Arguments
                .Count {
                return false
            }
            // Nested target tuples/designations still need recursive lowering.
            // Flat fresh `var` declarations can use G#'s inline let/var targets.
            for argument in leftTuple.Arguments {
                if argument.Expression is TupleExpressionSyntax ||
                    (
                    argument.Expression is DeclarationExpressionSyntax declaration &&
                        (
                        !declaration
                            .Type
                            .IsVar ||
                            declaration.Designation is ParenthesizedVariableDesignationSyntax ||
                            (
                            declaration.Designation is SingleVariableDesignationSyntax single &&
                                this
                                .context
                                .GetDeclaredSymbol(single) is ILocalSymbol local &&
                                this.DeconstructionLocalRequiresTypedDeclaration(local, declaration.Type.IsVar)
                        )
                    )
                ) {
                    return false
                }
            }
            let targets = List[GExpression](leftTuple.Arguments.Count)
            let targetBindings = List[BindingKind?](leftTuple.Arguments.Count)
            for argument in leftTuple.Arguments {
                if argument.Expression is DeclarationExpressionSyntax declaration {
                    if declaration.Designation is not SingleVariableDesignationSyntax single {
                        targets.Add(IdentifierExpression("_"))
                        targetBindings.Add(nil)
                        continue
                    }
                    let name string? = this.EmittedName(single, single.Identifier)
                    if name == "_" {
                        targets.Add(IdentifierExpression(name))
                        targetBindings.Add(nil)
                        continue
                    }
                    let local ILocalSymbol? = this.context.GetDeclaredSymbol(single) as ILocalSymbol
                    targets.Add(IdentifierExpression(name))
                    targetBindings.Add(
                        if local != nil && this.IsLocalReassigned(local) {
                            BindingKind.Var
                        } else {
                            BindingKind.Let
                        }
                    )
                    continue
                }
                targets.Add(this.TranslateExpression(argument.Expression)!!)
                targetBindings.Add(nil)
            }
            var unwrappedRight = right
            while unwrappedRight is ParenthesizedExpressionSyntax parenthesized {
                unwrappedRight = parenthesized.Expression
            }
            let values IReadOnlyList[GExpression] = if unwrappedRight is TupleExpressionSyntax rightTuple {
                cast[IReadOnlyList[GExpression]](
                    rightTuple
                        .Arguments
                        .Select(
                        (argument ArgumentSyntax) -> this.TranslateValueWithNullForgiveness(argument.Expression)!!
                    )
                        .ToList()
                )
            } else {
                cast[IReadOnlyList[GExpression]]([]GExpression{this.TranslateExpression(right)!!})
            }
            result = []GStatement{MultiAssignmentStatement(targets, values, targetBindings)}
            return true
        }

        // Expression-position deconstruction assignment (`var r = ((x, y) =
        // (1, 2));`, `M((a, b) = e)`, ...): the assignment's VALUE — a tuple
        // of the assigned elements, in target order — is needed by the
        // enclosing expression, so every element (including a discard) is
        // captured in a real temp and the value is rebuilt as a tuple literal
        // over those temps (issue #1974).
        private func LowerTupleAssignmentForValue(leftTuple TupleExpressionSyntax, right ExpressionSyntax?)(
            Statements List[GStatement],
            Value GExpression
        ) {
            this.RegisterProjectedDeconstructionBindings(leftTuple, right)
            let statements = List[GStatement]()
            let captured = this.CaptureDeconstructionStorageTargets(leftTuple, statements)
            let values = this.LowerTuplePattern(
                leftTuple,
                this.TranslateExpression(right),
                forceRealTemps: true,
                statements,
                captured,
                this.GetDeconstructionInfo(right),
                this.context.GetTypeInfo(right).Type as INamedTypeSymbol,
                receiverSyntax: right
            )
            let value GExpression = TupleLiteralExpression(values)
            this.state.TupleAssignmentValues[leftTuple] = value
            return (statements, value)
        }

        // Walks a (possibly nested) deconstruction-assignment target shape
        // and, for every indexer/member-access (or other existing storage-
        // location) leaf, spills its receiver/index sub-expression into a
        // temp via `MakeDuplicationSafeTarget` — the SAME machinery chained
        // assignment (`a[F()] = b[G()] = c`, issue #1731) already uses —
        // emitted into `statements` BEFORE anything about the right-hand
        // side. This preserves C#'s left-to-right, targets-then-value
        // evaluation order (issue #2234, generalizing #1895/#1974: a plain
        // identifier or a new `var`/nested-`var` binding has nothing
        // pre-existing to evaluate, so needs no capture; a nested tuple
        // target is walked recursively, since its own leaves are storage
        // locations too). Returns a map from each captured leaf's original
        // syntax to its now-single-evaluation-safe G# replacement, consulted
        // by `LowerTuplePattern` when it emits the final per-target
        // assignment.
        private func CaptureDeconstructionStorageTargets(
            pattern TupleExpressionSyntax,
            statements List[GStatement]
        ) Dictionary[ExpressionSyntax, GExpression] {
            let captured = Dictionary[ExpressionSyntax, GExpression]()
            this.CaptureDeconstructionStorageTargets(pattern, statements, captured)
            return captured
        }

        private func CaptureDeconstructionStorageTargets(
            pattern TupleExpressionSyntax,
            statements List[GStatement],
            captured Dictionary[ExpressionSyntax, GExpression]
        ) {
            for argument in pattern.Arguments {
                let targetExpr = argument.Expression
                switch targetExpr {
                    case nested is TupleExpressionSyntax {
                        this.CaptureDeconstructionStorageTargets(nested, statements, captured)
                    }
                    case IdentifierNameSyntax, DeclarationExpressionSyntax { }
                    default {
                        // An existing storage location (`arr[i]`, `obj.F`, ...):
                        // spill its receiver/index once, now, before the RHS.
                        captured[targetExpr] = this.MakeDuplicationSafeTarget(
                            this.TranslateExpression(targetExpr)!!,
                            statements,
                            targetExpr
                        )
                    }
                }
            }
        }

        // Core recursive lowering shared by the statement- and
        // expression-position forms above. `rhsValue` is the G# expression to
        // deconstruct — the fully translated original right-hand side on the
        // OUTERMOST call, or a bare temp-identifier read on a recursive call
        // for a nested target (already single-evaluation-safe, so it needs no
        // further spilling). Returns each element's resulting value (`null`
        // for a true discard when `forceRealTemps` is false, since nothing
        // captures its value in that case).
        private func LowerTuplePattern(
            pattern TupleExpressionSyntax,
            rhsValue GExpression?,
            forceRealTemps bool,
            statements List[GStatement],
            captured Dictionary[ExpressionSyntax, GExpression],
            deconstruction DeconstructionInfo,
            rhsTupleType INamedTypeSymbol? = nil,
            emittedReceiverType GTypeReference? = nil,
            receiverSyntax ExpressionSyntax? = nil,
            conversions List[GStatement]? = nil,
            assignments List[GStatement]? = nil,
            orderedConversions bool = false
        ) List[GExpression] {
            // Record adapters require every extraction and conversion before target writes.
            let ownsPhases = conversions == nil
            let effectiveReceiverType = rhsTupleType ?? if receiverSyntax != nil {
                this.context.GetTypeInfo(receiverSyntax).Type
            } else {
                default(ITypeSymbol?)
            }
            let orderedConversions = orderedConversions || forceRealTemps || this.RecordDeconstructionRunsUserCode(
                deconstruction,
                effectiveReceiverType
            )
            let conversionStatements = conversions ?? List[GStatement]()
            let assignmentStatements = assignments ?? List[GStatement]()
            let count = pattern.Arguments.Count
            let temps = List[string](count)
            let directNames = [count]bool
            for var i = 0; i < count; i++ {
                let targetExpr = pattern.Arguments[i].Expression
                // Issue #3501 (synthetic-name retirement): a single-variable
                // declaration element (`(int probeExit, _) = …`) binds its
                // REAL name directly in the native `let (…)` instead of a
                // structural temp plus a re-declaration — provided the local
                // is never reassigned (the tuple binding is `let`) and its
                // declared type matches the RHS element (a `var` designation
                // matches by construction; an explicit type must equal the
                // deconstructed element so no implicit conversion is lost).
                if targetExpr is DeclarationExpressionSyntax{
                    Designation: SingleVariableDesignationSyntax directSingle
                } directDecl &&
                    !this.IsPointerDeconstructTupleOutput(deconstruction.Method, i, effectiveReceiverType) &&
                    this
                    .context
                    .GetDeclaredSymbol(directSingle) is ILocalSymbol directLocal && !this.IsLocalReassigned(
                    directLocal
                ) &&
                    !this.DeconstructionLocalRequiresTypedDeclaration(directLocal, directDecl.Type.IsVar) &&
                    (
                    directDecl
                        .Type
                        .IsVar ||
                        (
                        rhsTupleType != nil &&
                            rhsTupleType.IsTupleType == true &&
                            i < rhsTupleType
                            .TupleElements
                            .Length &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(directLocal.Type, rhsTupleType.TupleElements[i].Type)
                    )
                ) {
                    temps.Add(this.EmittedName(directSingle, directSingle.Identifier)!!)
                    directNames[i] = true
                    continue
                }
                // A nested tuple target needs its own real temp to recurse
                // into — UNLESS every leaf underneath it is itself a true
                // discard, in which case the whole nested arm is dead and
                // the RHS element is an actual tuple. A custom Deconstruct
                // method must still run even when every output is discarded.
                let sideEffectFreeAllDiscardTuple = targetExpr is TupleExpressionSyntax nestedDiscardCheck &&
                    this.HasOnlyImmediateDiscards(nestedDiscardCheck) &&
                    rhsTupleType != nil &&
                    rhsTupleType.IsTupleType == true &&
                    i < rhsTupleType
                    .TupleElements
                    .Length &&
                    (rhsTupleType.TupleElements[i].Type is INamedTypeSymbol and {IsTupleType: true})
                let needsRealTemp = forceRealTemps ||
                    (!sideEffectFreeAllDiscardTuple && !this.IsDeconstructionDiscard(targetExpr))
                temps.Add(
                    if needsRealTemp {
                        this.AllocateDeconstructionTempName(targetExpr)
                    } else {
                        "_"
                    }
                )
            }
            // Spill the WHOLE right-hand side in one native decon-binding.
            // These temps are single-use compiler internals, never reassigned,
            // so use the immutable `let (...)` spelling even though ADR-0168
            // also permits mutable `var (...)`. This is exactly the mechanism the
            // declaration form (`var (a, b) = e`) already uses, so it inherits
            // the same RHS-shape support for free.
            statements.Add(
                TupleDeconstructionStatement(
                    BindingKind.Let,
                    temps,
                    this.RewriteRecordDeconstruction(
                        rhsValue,
                        deconstruction.Method,
                        pattern,
                        receiverSyntax,
                        emittedReceiverType,
                        rhsTupleType
                    )
                )
            )
            let values = List[GExpression](count)
            for var i = 0; i < count; i++ {
                let targetExpr = pattern.Arguments[i].Expression
                if temps[i] == "_" {
                    values.Add(default(GExpression))
                    continue
                }
                if (directNames[i]) {
                    // The element already bound its real name in the tuple
                    // binding — nothing to re-declare; the value read is the
                    // name itself.
                    values.Add(IdentifierExpression(temps[i]))
                    continue
                }
                var tempRead = cast[GExpression](IdentifierExpression(temps[i]))
                if this.IsPointerDeconstructTupleOutput(deconstruction.Method, i, effectiveReceiverType) {
                    tempRead = ConversionExpression(
                        this.MapDeconstructionOutputType(deconstruction, i, rhsTupleType)!!,
                        tempRead,
                        isCheckedReferenceCast: true
                    )
                }
                if targetExpr is TupleExpressionSyntax nestedTuple {
                    // Nested target (`((a, b), c) = ...`): the outer temp
                    // holds the nested element's value, itself a tuple — spill
                    // IT with a second native decon-binding rather than trying
                    // to flatten every depth into one `let (...)` (issue
                    // #1974). The recursive rhsValue is already a bare temp
                    // read, so no further spill is needed before recursing.
                    let nestedRhsTupleType = this.DeconstructionOutputType(
                        deconstruction,
                        i,
                        rhsTupleType
                    ) as INamedTypeSymbol
                    let nestedValues = this.LowerTuplePattern(
                        nestedTuple,
                        tempRead,
                        forceRealTemps,
                        statements,
                        captured,
                        this.NestedDeconstructionInfo(deconstruction, i),
                        nestedRhsTupleType,
                        this.MapDeconstructionOutputType(deconstruction, i, rhsTupleType),
                        this.DeconstructionOutputSyntax(receiverSyntax, i),
                        conversionStatements,
                        assignmentStatements,
                        orderedConversions
                    )
                    values.Add(
                        if forceRealTemps {
                            TupleLiteralExpression(nestedValues)
                        } else {
                            default(TupleLiteralExpression?)
                        }
                    )
                    continue
                }
                if targetExpr is DeclarationExpressionSyntax declaration {
                    let declaredValue GExpression? = this.LowerDeconstructionDeclaration(
                        declaration.Designation,
                        tempRead,
                        forceRealTemps,
                        statements,
                        this.NestedDeconstructionInfo(deconstruction, i),
                        declaration.Type.IsVar,
                        this.DeconstructionOutputType(deconstruction, i, rhsTupleType),
                        this.MapDeconstructionOutputType(deconstruction, i, rhsTupleType),
                        this.DeconstructionOutputSyntax(receiverSyntax, i),
                        conversionStatements
                    )
                    if declaredValue != nil {
                        values.Add(declaredValue)
                    } else {
                        values.Add(default(GExpression))
                    }
                    continue
                }
                // An existing local (or member/element access) target: write
                // the spilled value back. A discard target still gets a real
                // temp here (`forceRealTemps=true`, e.g. expression-position
                // `(x, _) = (1, 2)`) so its value can be reconstructed into
                // the outer tuple, but `_` isn't a real assignable location —
                // skip the write itself to avoid emitting a stray, dead
                // discard write-back statement (issue #2099).
                var assignedValue GExpression = tempRead
                if !this.IsDeconstructionDiscard(targetExpr) {
                    // A member/element-access target was already captured
                    // into a duplication-safe replacement BEFORE the RHS was
                    // spilled above (issue #2234); a plain identifier has no
                    // entry and translates as-is.
                    let assignTarget GExpression? = if captured.TryGetValue(targetExpr, out var safeTarget) {
                        safeTarget
                    } else {
                        this.TranslateExpression(targetExpr)
                    }
                    assignedValue = this.ConvertDeconstructionAssignmentValue(
                        targetExpr,
                        tempRead,
                        conversionStatements,
                        orderedConversions
                    )
                    assignmentStatements.Add(AssignmentStatement(assignTarget, assignedValue))
                }
                values.Add(assignedValue)
            }
            if ownsPhases {
                statements.AddRange(conversionStatements)
                statements.AddRange(assignmentStatements)
            }
            return values
        }

        private func ConvertDeconstructionAssignmentValue(
            target ExpressionSyntax,
            value GExpression,
            conversions List[GStatement],
            materialize bool
        ) GExpression {
            let bridged = this.BridgeDeconstructedElementStore(target, value)!!
            if !materialize {
                return bridged
            }
            if !this.TryGetDeconstructionSlotInfo(target, out var conversion, out var sourceType) ||
                (conversion.IsIdentity && object.ReferenceEquals(bridged, value)) {
                return bridged
            }
            let symbol = this.GetProjectedAssignmentTarget(target, this.context.GetSymbolInfo(target).Symbol)
            let targetType = this.GetAssignmentTargetType(target, symbol)
            if targetType == nil {
                return bridged
            }
            var mappedType = this.typeMapper.Map(targetType, this.context, target.GetLocation())
            if symbol is ILocalSymbol local {
                mappedType = this.PromoteIfUsedAsNullable(mappedType, local)
            }
            let converted = this.BuildConvertedDeconstructionValue(
                bridged,
                sourceType,
                targetType,
                mappedType,
                conversion,
                target.GetLocation()
            )
            let temp = this.AllocateDeconstructionTempName(target)
            conversions.Add(LocalDeclarationStatement(BindingKind.Let, temp, mappedType, converted))
            return IdentifierExpression(temp)
        }

        // Issue #5561: the store bridge of `target = element` for a variable,
        // field, property or element (#5595) that a deconstruction assigns. The temp holds the
        // `Deconstruct` element, which G# types from its declaration, so a
        // widened element stored into a slot that stays non-null is asserted
        // exactly as `n = entry.Item!!` is. The slot is the input of a
        // user-defined conversion, as in `ForgiveNullableReferenceValueCore`, or
        // else the target's storage. A local's storage is what its declaration
        // emitted (`EmittedLocalStorageAcceptsNil`), and a local with no record
        // is not bridged; any other target is decided by its declaration, as
        // for a plain assignment. An array element or indexer target is decided
        // by `ElementAccessStoreRequiresNonNullReference`, the query of the plain
        // `arr[0] = entry.Item` (#2259).
        private func BridgeDeconstructedElementStore(target ExpressionSyntax, value GExpression) GExpression? {
            if !(
                target is IdentifierNameSyntax ||
                    target is MemberAccessExpressionSyntax ||
                    target is ElementAccessExpressionSyntax
            ) {
                return value
            }
            let model = this.context.SemanticModel
            let element = ObliviousNullabilityAnalyzer.DeconstructedElementDeclaration(
                target,
                model,
                this.context.RepositoryCompilations ?? this.context.SiblingCompilations
            )
            if element == nil || !this.IsTranslatorWidenedDeclaration(element) {
                return value
            }
            var slot ISymbol? = this.GetProjectedAssignmentTarget(target, this.context.GetSymbolInfo(target).Symbol)
            var slotType ITypeSymbol? = this.GetAssignmentTargetType(target, slot)
            if ObliviousNullabilityAnalyzer.DeconstructedElementConversionOperator(target, model) is {} conversion {
                slot = conversion.Parameters[0]
                slotType = conversion.Parameters[0].Type
            } else if slot is ILocalSymbol local {
                // A local whose emitted storage is not recorded keeps the
                // unbridged store: a wrong
                // `!!` would throw where C# stores the null, and a wrong
                // omission is a compile error that gsc reports.
                return if this
                    .state
                    .EmittedLocalStorageAcceptsNil
                    .TryGetValue(local, out var acceptsNil) &&
                    !acceptsNil {
                    this.ReportStoreBridge(target, value, EnsureNonNullAssertion(value), slot, slotType)
                } else {
                    value
                }
            } else if target is ElementAccessExpressionSyntax access {
                // An array element whose storage is not a declaration keeps the
                // unbridged store, as a local with no record does.
                if slot == nil && this.ArrayElementStorage(access).Root == nil {
                    return value
                }
                return if this.ElementAccessStoreRequiresNonNullReference(target) {
                    this.ReportStoreBridge(
                        target,
                        value,
                        EnsureNonNullAssertion(value),
                        slot ?? this.context.GetTypeInfo(access.Expression).Type as IArrayTypeSymbol,
                        slotType
                    )
                } else {
                    value
                }
            }
            return if this.TargetWillRemainNonNullableReference(slotType, slot) {
                this.ReportStoreBridge(target, value, EnsureNonNullAssertion(value), slot, slotType)
            } else {
                value
            }
        }

        // G# tuple bindings are deliberately flat (ADR-0168; the issue #4300
        // driver probe rejects `let (a, (b, c)) = ...`), so recursive lowering
        // still needs a carrier for each structural arm. Derive that carrier
        // from the first source leaf and reserve every identifier in the body;
        // this is the smallest collision-safe replacement for `__deconN`.
        private func AllocateDeconstructionTempName(anchor SyntaxNode, preferredName string? = nil) string {
            let stem = this.nameAllocator.GetName(preferredName ?? this.DeconstructionTempStem(anchor))
            let body = this.state.CurrentBodyScope ?? anchor.SyntaxTree.GetRoot()
            let occupied = this.CollectOccupiedSynthesizedLocalNames(body)
            if !this.state.DeconstructionTempNamesByBody.TryGetValue(body, out var allocated) {
                allocated = HashSet[string](StringComparer.Ordinal)
                this.state.DeconstructionTempNamesByBody.Add(body, allocated)
            }
            var candidate = stem
            for var suffix = 2; occupied.Contains(candidate) || allocated.Contains(candidate) ||
                !this.ReserveSynthesizedLocalName(candidate, anchor); suffix++ {
                candidate = stem + suffix.ToString(CultureInfo.InvariantCulture)
            }
            allocated.Add(candidate)
            occupied.Add(candidate)
            return candidate
        }

        private func CollectOccupiedSynthesizedLocalNames(body SyntaxNode) HashSet[string] {
            if this.state.SynthesizedLocalOccupiedNamesByBody.TryGetValue(body, out var existing) {
                return existing
            }
            let DescendIntoCurrentBody = func (node SyntaxNode) bool {
                return object.ReferenceEquals(node, body) ||
                    !((node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax))
            }
            let occupied = HashSet[string](StringComparer.Ordinal)
            this.state.SynthesizedLocalOccupiedNamesByBody[body] = occupied
            for token in body.DescendantTokens(DescendIntoCurrentBody) {
                if token.IsKind(SyntaxKind.IdentifierToken) {
                    occupied.Add(this.nameAllocator.GetName(token.ValueText))
                }
            }
            for localFunction in body.DescendantNodes().OfType[LocalFunctionStatementSyntax]() {
                if FindNestedFunction(localFunction.Parent, body) == nil {
                    occupied.Add(this.EmittedName(localFunction, localFunction.Identifier)!!)
                }
            }
            for name in body.DescendantNodes().OfType[SimpleNameSyntax]() {
                if FindNestedFunction(name.Parent, body) == nil {
                    continue
                }
                let symbol ISymbol? = this.context.GetSymbolInfo(name).Symbol
                if symbol != nil && !IsDeclaredInNestedFunction(symbol, body) {
                    occupied.Add(this.EmittedName(symbol, name.Identifier.ValueText)!!)
                }
            }
            return occupied
        }

        private func DeconstructionTempStem(anchor SyntaxNode) string {
            let declaredLeaf SingleVariableDesignationSyntax? = anchor
                .DescendantNodesAndSelf()
                .OfType[SingleVariableDesignationSyntax]()
                .FirstOrDefault()
            let sourceLeaf = declaredLeaf?.Identifier ?? anchor.DescendantTokens().FirstOrDefault(
                (token SyntaxToken) -> token.IsKind(SyntaxKind.IdentifierToken) &&
                    token.ValueText != "_" &&
                    token.ValueText != "var"
            )
            let leaf = if sourceLeaf.RawKind == 0 {
                "deconstructed"
            } else {
                this.nameAllocator.GetName(sourceLeaf.ValueText)
            }
            let structural = anchor is TupleExpressionSyntax ||
                anchor is ParenthesizedVariableDesignationSyntax ||
                anchor is DeclarationExpressionSyntax &&
                anchor.Designation is ParenthesizedVariableDesignationSyntax
            return leaf +
                (
                if structural {
                    "Tuple"
                } else {
                    "Value"
                }
            )
        }

        private func LowerDeconstructionDeclaration(
            designation VariableDesignationSyntax,
            value GExpression,
            preserveValue bool,
            statements List[GStatement],
            deconstruction DeconstructionInfo,
            inferredType bool,
            receiverType ITypeSymbol? = nil,
            emittedReceiverType GTypeReference? = nil,
            receiverSyntax ExpressionSyntax? = nil,
            conversions List[GStatement]? = nil
        ) GExpression? {
            if designation is DiscardDesignationSyntax {
                return if preserveValue {
                    value
                } else {
                    default(GExpression?)
                }
            }
            if designation is SingleVariableDesignationSyntax single {
                let name = this.EmittedName(single, single.Identifier)
                let local ILocalSymbol? = this.context.GetDeclaredSymbol(single) as ILocalSymbol
                var type = if inferredType && local != nil && this.DeconstructionLocalRequiresTypedDeclaration(
                    local,
                    true
                ) {
                    MakeNullable(this.MapInferredLocalDeclarationType(local, single.GetLocation()))
                } else if !inferredType && local != nil {
                    this.typeMapper.Map(local.Type, this.context, single.GetLocation())
                } else {
                    default(GTypeReference?)
                }
                var initializer = value
                if local != nil {
                    type = this.PromoteIfUsedAsNullable(type, local)
                    if !inferredType && this.IsTranslatorWidenedDeclaration(local) {
                        type = MakeNullable(type)
                    }
                    if this.TryGetDeconstructionSlotInfo(single, out var conversion, out var sourceType) &&
                        !conversion
                        .IsIdentity {
                        initializer = this.BuildConvertedDeconstructionValue(
                            value,
                            sourceType,
                            local.Type,
                            type,
                            conversion,
                            single.GetLocation()
                        )
                    }
                    if type != nil {
                        this.state.EmittedLocalTypeClauses.Add(local)
                        this.RecordEmittedLocalNullability(local, type, nil, initializer)
                    }
                }
                (conversions ?? statements).Add(
                    LocalDeclarationStatement(
                        if local != nil && this.IsLocalReassigned(local) {
                            BindingKind.Var
                        } else {
                            BindingKind.Let
                        },
                        name,
                        type,
                        initializer: initializer
                    )
                )
                return IdentifierExpression(name)
            }
            let effectiveReceiverType = receiverType ?? if receiverSyntax != nil {
                this.context.GetTypeInfo(receiverSyntax).Type
            } else {
                default(ITypeSymbol?)
            }
            let parenthesized = cast[ParenthesizedVariableDesignationSyntax](designation)
            let temps = List[string](parenthesized.Variables.Count)
            let directNames = [parenthesized.Variables.Count]bool
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                let child = parenthesized.Variables[i]
                if !preserveValue && !this.IsPointerDeconstructTupleOutput(
                    deconstruction.Method,
                    i,
                    effectiveReceiverType
                ) &&
                    child is SingleVariableDesignationSyntax childSingle &&
                    this
                    .context
                    .GetDeclaredSymbol(childSingle) is ILocalSymbol local && !this.IsLocalReassigned(local) &&
                    !this
                    .DeconstructionLocalRequiresTypedDeclaration(local, inferredType) {
                    temps.Add(this.EmittedName(childSingle, childSingle.Identifier)!!)
                    directNames[i] = true
                } else {
                    temps.Add(
                        if !preserveValue && child is DiscardDesignationSyntax {
                            "_"
                        } else {
                            this.AllocateDeconstructionTempName(child)
                        }
                    )
                }
            }
            statements.Add(
                TupleDeconstructionStatement(
                    BindingKind.Let,
                    temps,
                    this.RewriteRecordDeconstruction(
                        value,
                        deconstruction.Method,
                        designation,
                        receiverSyntax,
                        emittedReceiverType,
                        receiverType
                    )
                )
            )
            let values = List[GExpression](parenthesized.Variables.Count)
            for var i = 0; i < parenthesized.Variables.Count; i++ {
                if temps[i] == "_" {
                    values.Add(default(GExpression))
                    continue
                }
                if (directNames[i]) {
                    values.Add(IdentifierExpression(temps[i]))
                    continue
                }
                var elementValue GExpression = IdentifierExpression(temps[i])
                if this.IsPointerDeconstructTupleOutput(deconstruction.Method, i, effectiveReceiverType) {
                    elementValue = ConversionExpression(
                        this.MapDeconstructionOutputType(deconstruction, i, receiverType)!!,
                        elementValue,
                        isCheckedReferenceCast: true
                    )
                }
                let declaredValue GExpression? = this.LowerDeconstructionDeclaration(
                    parenthesized.Variables[i],
                    elementValue,
                    preserveValue,
                    statements,
                    this.NestedDeconstructionInfo(deconstruction, i),
                    inferredType,
                    this.DeconstructionOutputType(deconstruction, i, receiverType),
                    this.MapDeconstructionOutputType(deconstruction, i, receiverType),
                    this.DeconstructionOutputSyntax(receiverSyntax, i),
                    conversions
                )
                if declaredValue != nil {
                    values.Add(declaredValue)
                } else {
                    values.Add(default(GExpression))
                }
            }
            return if preserveValue {
                TupleLiteralExpression(values)
            } else {
                default(TupleLiteralExpression?)
            }
        }

        private func LowerTupleDeclaration(
            designation ParenthesizedVariableDesignationSyntax,
            right ExpressionSyntax,
            inferredType bool
        ) IEnumerable[GStatement] {
            return this.WithHoistedAssignments(
                right,
                includeSelf: true,
                func () List[GStatement] {
                    let statements = List[GStatement]()
                    let conversions = List[GStatement]()
                    this.LowerDeconstructionDeclaration(
                        designation,
                        this.TranslateExpression(right)!!,
                        preserveValue: false,
                        statements,
                        this.GetDeconstructionInfo(right),
                        inferredType,
                        this.context.GetTypeInfo(right).Type,
                        receiverSyntax: right,
                        conversions: conversions
                    )
                    statements.AddRange(conversions)
                    return statements
                }
            )
        }

        // Native tuple bindings cannot carry a leaf's nullable storage clause.
        private func DeconstructionLocalRequiresTypedDeclaration(local ILocalSymbol, inferredType bool) bool {
            if !inferredType {
                return IsAnnotatedNullableReference(local.Type) || this.ShouldPromoteToNullableReference(local)
            }
            if this.InferredLocalDefaultRequiresTypedDeclaration(local) {
                return true
            }
            if !this.IsLocalReassigned(local) ||
                !(
                this.InferredLocalDeclarationIsNullable(local) ||
                    local
                    .Type
                    .IsReferenceType &&
                    this.TryGetRefStorageSlot(local, 0) is {} slot && this.RefStorageIsNullable(
                    slot,
                    includeArrays: true
                )
            ) {
                return false
            }
            let initializer = this.GetInferredLocalInitializer(local, out _, out _)
            return initializer == nil || this.GSharpExpressionIsStaticallyNonNull(initializer)
        }

        private func TryGetDeconstructionTargets(
            left ExpressionSyntax,
            out binding BindingKind,
            out names IReadOnlyList[string]?
        ) bool {
            binding = BindingKind.Let
            names = nil
            // `var (a, b) = e`.
            if left is DeclarationExpressionSyntax{Designation: ParenthesizedVariableDesignationSyntax parenthesized} {
                if parenthesized.Variables.Any(
                    (designation VariableDesignationSyntax) -> designation is ParenthesizedVariableDesignationSyntax
                ) {
                    return false
                }
                let collected = List[string]()
                for designation in parenthesized.Variables {
                    if designation is ParenthesizedVariableDesignationSyntax {
                        return false
                    }
                    collected.Add(
                        switch designation {
                            case single is SingleVariableDesignationSyntax: this.EmittedName(single, single.Identifier)
                            default: "_"
                        }
                    )
                    // Issue #1967: `var (i, r) = ...` declares each element via a
                    // designation, not a declarator.
                    if designation is SingleVariableDesignationSyntax indexCheckSingle {
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local {
                            if this.DeconstructionLocalRequiresTypedDeclaration(local, true) {
                                return false
                            }
                            if this.IsLocalReassigned(local) {
                                binding = BindingKind.Var
                            }
                        }
                    }
                }
                names = collected
                return true
            }
            // `(var a, var b) = e`.
            if left is TupleExpressionSyntax tuple && tuple.Arguments.All(
                (a ArgumentSyntax) -> (
                    a.Expression is DeclarationExpressionSyntax and
                        {Designation: SingleVariableDesignationSyntax or DiscardDesignationSyntax}
                )
            ) {
                let collected = List[string]()
                for argument in tuple.Arguments {
                    let declaration = cast[DeclarationExpressionSyntax](argument.Expression)
                    if declaration.Designation is ParenthesizedVariableDesignationSyntax ||
                        (
                        !declaration
                            .Type
                            .IsVar &&
                            (
                            !this.TryGetDeconstructionSlotInfo(declaration, out var conversion, out _) ||
                                !conversion.IsIdentity
                        )
                    ) {
                        return false
                    }
                    collected.Add(
                        switch declaration.Designation {
                            case single is SingleVariableDesignationSyntax: this.EmittedName(single, single.Identifier)
                            default: "_"
                        }
                    )
                    // Issue #1967: `(var i, var r) = ...` — same as above, one
                    // designation per tuple element.
                    if declaration.Designation is SingleVariableDesignationSyntax indexCheckSingle {
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol local &&
                            this.DeconstructionLocalRequiresTypedDeclaration(local, declaration.Type.IsVar) {
                            return false
                        }
                        if this.context.GetDeclaredSymbol(indexCheckSingle) is ILocalSymbol reassignedLocal &&
                            this.IsLocalReassigned(reassignedLocal) {
                            binding = BindingKind.Var
                        }
                    }
                }
                names = collected
                return true
            }
            return false
        }

        private func TranslateLock(lockStatement LockStatementSyntax) GStatement {
            // Issue #1885: G# has a first-class `lock target { body }` statement
            // with the SAME single-evaluation, Monitor.Enter/try-finally/
            // Monitor.Exit semantics as C#'s `lock`, so the translated target
            // is emitted once and gsc lowers it — no manual Monitor lowering
            // (and no missing `import System.Threading`) needed here.
            let target = this.TranslateExpression(lockStatement.Expression)
            let body = this.TranslateStatementAsBlock(lockStatement.Statement)
            return LockStatement(target, body)
        }

        // Spills `operand` into a fresh `let` in the active statement seam's
        // prologue (see <see cref="pendingSpillPrologue"/>/<see
        // cref="WithSpillSeam"/>) and returns a reference to that local, UNLESS
        // `operand` is already trivial (see <see cref="IsTrivialOperand"/>) — a
        // bare local/`this`/literal is safe to duplicate as-is, so spilling it
        // would only add clutter. When no statement seam is active (translating
        // outside any statement, or across a lambda/local-function boundary —
        // see <see cref="TranslateLambda"/>/<see cref="TranslateLocalFunction"/>)
        // the operand is conservatively left embedded as-is rather than spilled
        // into an unrelated scope.
        private func SpillOperand(operand GExpression, forceNonTrivial bool = false) GExpression -> this.SpillOperand(
            operand,
            this.state.PendingSpillPrologue,
            forceNonTrivial
        )

        // As above, but retains a loud fallback for a future expression-only
        // site that fails to open either a statement seam or issue #3355's
        // native block-expression seam.
        //
        // `forceNonTrivial` suppresses the <see cref="IsTrivialOperand"/>
        // shortcut. That shortcut answers "is duplicating this expression
        // safe?", which is the wrong question for a caller that is REORDERING
        // evaluation rather than duplicating it: a bare identifier is safe to
        // read twice, but it is NOT safe to read it LATER than written when
        // another operand that moved ahead of it can mutate what it names
        // (PR #4211's third review round — see
        // <see cref="SnapshotPermutedArgumentOperand"/>).
        private func SpillOperand(
            operand GExpression,
            operandSyntaxForDiagnostic SyntaxNode,
            forceNonTrivial bool = false
        ) GExpression {
            if !forceNonTrivial && IsTrivialOperand(operand) {
                return operand
            }
            if this.CanAssignShortCircuitSpill(operandSyntaxForDiagnostic) {
                return this.AssignShortCircuitSpill(operand, operandSyntaxForDiagnostic)
            }
            if this.state.PendingSpillPrologue != nil {
                return this.SpillOperand(operand, forceNonTrivial)
            }
            let message = "a non-trivial operand reached an expression-only translation site without opening " +
                "a native block-expression spill seam; emitting it in place would evaluate it more " +
                "than once, or out of source order."
            this.context.ReportUnsupported(operandSyntaxForDiagnostic, message)
            return operand
        }

        private func CanAssignShortCircuitSpill(operandSyntax SyntaxNode) bool {
            if this
                .state
                .ShortCircuitSpillDeclarations == nil ||
                this
                .state
                .PendingSpillPrologue == nil ||
                this
                .state
                .ShortCircuitSpillScope == nil {
                return false
            }
            for var current SyntaxNode? = operandSyntax; current != nil; current = current!!.Parent {
                if current == this.state.ShortCircuitSpillScope {
                    return true
                }
                if current is AnonymousFunctionExpressionSyntax || current is LocalFunctionStatementSyntax {
                    return false
                }
            }
            return false
        }

        private func AssignShortCircuitSpill(operand GExpression, operandSyntax SyntaxNode) GExpression {
            let typeInfo = this.context.GetTypeInfo(operandSyntax)
            let operandType ITypeSymbol? = typeInfo.Type ?? typeInfo.ConvertedType
            if operandType == nil || operandType.TypeKind == TypeKind.Error {
                this.context.ReportUnsupported(
                    operandSyntax,
                    "a short-circuited fallback pattern scrutinee has no resolvable type for its deferred spill local (issue #3419)."
                )
                return this.SpillOperand(operand)
            }
            var spillType = this.typeMapper.Map(operandType, this.context, operandSyntax.GetLocation())
            if operandType.IsReferenceType {
                spillType = MakeNullable(spillType)!!
            }
            let temp = this.NewSpillName()
            let reference = IdentifierExpression(temp)
            this.state.ShortCircuitSpillDeclarations!!.Add(LocalDeclarationStatement(BindingKind.Var, temp, spillType))
            this.state.PendingSpillPrologue!!.Add(AssignmentStatement(reference, operand))
            return reference
        }

        // Issue #3355: field/property initializers and constructor-initializer
        // arguments can host spill statements directly in a native block
        // expression. No result-type lookup or synthesized helper is needed.
        private func TranslateNullSeamExpression(expression ExpressionSyntax) GExpression {
            return this.TranslateWithBlockSpillSeam(
                func () GExpression {
                    return this.TranslateExpression(expression)!!
                }
            )
        }

        private func TranslateNullSeamArguments(
            arguments SeparatedSyntaxList[ArgumentSyntax],
            preserveNames bool = true
        ) List[GExpression] {
            return arguments.Select(
                (argument ArgumentSyntax) -> this.TranslateNullSeamArgument(argument, preserveNames)
            )
                .ToList()
        }

        private func TranslateNullSeamArgument(argument ArgumentSyntax, preserveName bool) GExpression {
            var value GExpression
            if (
                argument.RefKindKeyword.IsKind(SyntaxKind.RefKeyword) || argument.RefKindKeyword.IsKind(
                    SyntaxKind.OutKeyword
                )
            ) &&
                !(argument.Expression is DeclarationExpressionSyntax) &&
                argument.Expression is not(IdentifierNameSyntax and {Identifier: {ValueText: "_"}}) {
                // Keep address-of outermost so gsc's ref/out call binder sees
                // the expected argument shape: `&{ spills; lvalue }`.
                value = UnaryExpression(
                    "&",
                    this.TranslateWithBlockSpillSeam(
                        func () GExpression {
                            return WithoutNonNullAssertion(this.TranslateExpression(argument.Expression))!!
                        }
                    )
                )
            } else if argument.Expression is DeclarationExpressionSyntax {
                value = this.TranslateArgumentValue(argument)!!
            } else {
                value = this.TranslateWithBlockSpillSeam(
                    func () GExpression {
                        return this.TranslateArgumentValue(argument)!!
                    }
                )
            }
            return if argument.NameColon == nil || !preserveName {
                value
            } else {
                cast[GExpression](
                    NamedArgumentExpression(
                        this.EmittedName(
                            this.context.GetSymbolInfo(argument.NameColon!!.Name).Symbol,
                            argument.NameColon!!.Name.Identifier.ValueText
                        ),
                        value
                    )
                )
            }
        }

        private func TranslateWithBlockSpillSeam(translate() -> GExpression) GExpression {
            if this.state.PendingSpillPrologue != nil {
                return translate()
            }
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let spillPrologue = List[GStatement]()
            this.state.PendingSpillPrologue = spillPrologue
            this.state.FunctionArgumentOutDeclarations = spillPrologue
            try {
                let value = translate()
                return if spillPrologue.Count == 0 {
                    value
                } else {
                    cast[GExpression](BlockExpression(spillPrologue, value))
                }
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
            }
        }

        // As above, but appends the spill declaration directly to an explicit
        // `prologue` list rather than the ambient one — used by callers (e.g.
        // <see cref="FlattenChainedAssignment"/>) that already build their own
        // ordered statement list and know exactly where the spill must land,
        // independent of whatever statement seam happens to be active.
        private func SpillOperand(
            operand GExpression,
            prologue List[GStatement]?,
            forceNonTrivial bool = false
        ) GExpression {
            if (!forceNonTrivial && IsTrivialOperand(operand)) || prologue == nil {
                return operand
            }
            let temp = this.NewSpillName()
            prologue.Add(LocalDeclarationStatement(BindingKind.Let, temp, type: nil, initializer: operand))
            return IdentifierExpression(temp)
        }

        private func NewSpillName() string {
            var candidate string
            do {
                candidate = "__spill${this.state.SpillCounter}"
                this.state.SpillCounter++
            } while !this.TryClaimSynthesizedLocalName(candidate)
            return candidate
        }

        // Rebuilds an assignment TARGET (a link's left-hand side in a chained
        // assignment `a = TARGET = c`) so its receiver/index sub-expression is
        // evaluated exactly once even though the target is written to (and, for
        // a compound-operator link, read back — see
        // <see cref="FlattenChainedAssignment"/>) — the receiver of a member
        // access and the index of an element access are each spilled at most
        // once via <see cref="SpillOperand(GExpression, List{GStatement})"/>,
        // and the target is rebuilt from those (now-trivial) pieces (issue
        // #1731). A target that is already an identifier/`this`/literal, or a
        // member access whose receiver needs no spilling, passes through
        // untouched.
        private func MakeDuplicationSafeTarget(
            target GExpression,
            prologue List[GStatement],
            syntax ExpressionSyntax? = nil
        ) GExpression {
            switch target {
                case member is MemberAccessExpression {
                    return MemberAccessExpression(
                        this.MakeDuplicationSafeTarget(
                            member.Target,
                            prologue,
                            (syntax as MemberAccessExpressionSyntax)?.Expression
                        ),
                        member.MemberName
                    )
                }
                case index is IndexExpression {
                    // `^n` is contextual index syntax: spilling the whole expression
                    // turns `target[^n]` into `let i = ^n; target[i]`, which loses
                    // from-end semantics. Spill only `n` and keep `^` at the access.
                    let safeTarget = this.MakeDuplicationSafeTarget(
                        index.Target,
                        prologue,
                        (syntax as ElementAccessExpressionSyntax)?.Expression
                    )
                    let isFromEnd = syntax is ElementAccessExpressionSyntax elementAccess &&
                        elementAccess
                        .ArgumentList
                        .Arguments
                        .Count == 1 &&
                        elementAccess
                        .ArgumentList
                        .Arguments[0]
                        .Expression
                        .IsKind(SyntaxKind.IndexExpression)
                    if index.Indices.Count > 1 {
                        // Issue #4350: a multi-parameter indexer spills every
                        // argument, left to right, so each still runs once.
                        return IndexExpression(
                            safeTarget,
                            index.Indices.Select((i GExpression) -> this.SpillOperand(i, prologue)).ToList()
                        )
                    }
                    let safeIndex = if isFromEnd && index.Index is FromEndIndexExpression fromEnd {
                        cast[GExpression](FromEndIndexExpression(this.SpillOperand(fromEnd.Operand, prologue)))
                    } else {
                        this.SpillOperand(index.Index, prologue)
                    }
                    return IndexExpression(safeTarget, safeIndex)
                }
                default {
                    return this.SpillOperand(target, prologue)
                }
            }
        }

        // Establishes a fresh statement seam (issue #1731) around a single
        // value-producing translation that has no `TranslateStatement` seam of
        // its own — a member/lambda/local-function arrow body, which behaves
        // like an implicit `return expr;` statement. Any spill collected while
        // running `translate` is emitted immediately ahead of its result, then
        // the ambient seam is restored (mirrors <see cref="TranslateStatement"/>).
        private func WithSpillSeam(translate() -> IReadOnlyList[GStatement]) IReadOnlyList[GStatement] {
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let spillPrologue = List[GStatement]()
            this.state.PendingSpillPrologue = spillPrologue
            this.state.FunctionArgumentOutDeclarations = spillPrologue
            try {
                let core = translate()
                if spillPrologue.Count == 0 {
                    return core
                }
                let combined = List[GStatement](spillPrologue)
                combined.AddRange(core)
                return combined
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
            }
        }

        private func TranslateLocalFunction(localFunction LocalFunctionStatementSyntax) IReadOnlyList[GStatement] {
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedSuspending &&
                this
                .state
                .UnsupportedSuspendingRefCaptureLocalFunctions
                .Contains(unsupportedSuspending) {
                this.context.ReportUnsupported(
                    localFunction,
                    "recursive async or iterator local function '${localFunction.Identifier.Text}' captures storage written in its declaring scope; G# forbids the ref parameter needed to preserve that shared storage on a suspending helper."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: suspending recursive local function '${localFunction.Identifier.Text}' requires a ref capture"
                    )
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedGeneric &&
                this
                .state
                .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                .Contains(unsupportedGeneric) {
                this.context.ReportUnsupported(
                    localFunction,
                    "recursive local function '${localFunction.Identifier.Text}' cannot preserve an enclosing type parameter in G# lowering."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: recursive local function '${localFunction.Identifier.Text}' cannot preserve an enclosing type parameter"
                    )
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol unsupportedTopLevel &&
                this
                .state
                .UnsupportedTopLevelRecursiveLocalFunctions
                .Contains(unsupportedTopLevel) {
                this.context.ReportUnsupported(
                    localFunction,
                    "top-level recursive local function '${localFunction.Identifier.Text}' requires a member-helper fallback, but top-level statements have no containing aggregate for that helper."
                )
                return []GStatement{
                    RawStatement(
                        "// unsupported: top-level recursive local function '${localFunction.Identifier.Text}'"
                    )
                }
            }
            // Issue #4302: a lifted helper keeps `ref` on its own signature, but
            // a delegate or function value built from it is a value-returning
            // wrapper that drops the aliasing contract. Decide this before any
            // lift path returns, so every lowering of a ref-returning local
            // used as a value stays a loud gap.
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol refValueLocal &&
                (refValueLocal.ReturnsByRef || refValueLocal.ReturnsByRefReadonly) &&
                (
                this.IsLocalFunctionReferencedAsValue(
                    refValueLocal,
                    GetLocalFunctionSiblingStatements(localFunction)
                ) ||
                    this.IsLocalFunctionReferencedAsValueFromAnotherSwitchSection(refValueLocal, localFunction)
            ) {
                this.context.ReportUnsupported(
                    localFunction,
                    "ref-returning local function '${localFunction.Identifier.Text}' cannot be used as a delegate or function value in G#."
                )
                return []GStatement{
                    RawStatement("// unsupported: ref-returning local function '${localFunction.Identifier.Text}'")
                }
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol recursiveLocal &&
                this
                .state
                .LiftedRecursiveLocalFunctions
                .TryGetValue(recursiveLocal, out var recursiveLift) {
                if recursiveLift
                    .Captures
                    .Count > 0 &&
                    (
                    this.IsLocalFunctionReferencedAsValue(
                        recursiveLocal,
                        GetLocalFunctionSiblingStatements(localFunction)
                    ) ||
                        this.IsLocalFunctionReferencedAsValueFromAnotherSwitchSection(recursiveLocal, localFunction)
                ) {
                    this.context.ReportUnsupported(
                        localFunction,
                        "capturing recursive local function '${localFunction.Identifier.Text}' cannot be used as a delegate or function value after member lifting."
                    )
                    return []GStatement{
                        RawStatement(
                            "// unsupported: capturing recursive local function value '${localFunction.Identifier.Text}'"
                        )
                    }
                }
                if !this.state.EmittedLiftedRecursiveLocalFunctions.Add(recursiveLocal) {
                    return []GStatement{RawStatement("// lifted recursive local function ${recursiveLift.Name}")}
                }
                let liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword)
                let liftedParameters = this.MapParameters(recursiveLocal, localFunction.ParameterList, skipFirst: false)
                for capture in recursiveLift.Captures {
                    var captureType ITypeSymbol? = switch capture.Symbol {
                        case local is ILocalSymbol: local.Type
                        case parameter is IParameterSymbol: parameter.Type
                        default: default(ITypeSymbol?)
                    }
                    if captureType == nil {
                        continue
                    }
                    if captureType.IsReferenceType && !CaptureHasExplicitNullableType(capture.Symbol) {
                        captureType = captureType.WithNullableAnnotation(
                            Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated
                        )
                    }
                    liftedParameters.Add(
                        Parameter(
                            this.EmittedName(capture.Symbol, capture.Symbol.Name),
                            this.typeMapper.Map(captureType, this.context, capture.Symbol.Locations.FirstOrDefault()),
                            refKind: if capture.IsByRef {
                                "ref"
                            } else {
                                default(string?)
                            }
                        )
                    )
                }
                let liftedReturnType = this.MapDelegateLikeReturnType(
                    recursiveLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation()
                )
                let liftedTypeParameters = this.MapMethodTypeParameters(recursiveLocal)
                let liftedBody = this.TranslateBody(
                    localFunction,
                    "recursive local function '${localFunction.Identifier.Text}'"
                )
                let helper = MethodDeclaration(
                    recursiveLift.Name,
                    liftedParameters,
                    liftedReturnType,
                    liftedBody,
                    liftedTypeParameters,
                    visibility: Visibility.Private,
                    isAsync: liftedIsAsync,
                    isRefReturn: recursiveLocal.ReturnsByRef || recursiveLocal.ReturnsByRefReadonly,
                    isReadOnlyRefReturn: recursiveLocal.ReturnsByRefReadonly
                )
                if recursiveLift.IsStatic {
                    (
                        this
                            .state
                            .PendingStaticSynthHelpers ??
                            throw InvalidOperationException(
                            "A recursive static local-function lift must be emitted inside an aggregate."
                        )
                    ).Add(helper)
                } else {
                    (
                        this
                            .state
                            .PendingInstanceSynthHelpers ??
                            throw InvalidOperationException(
                            "A recursive instance local-function lift must be emitted inside an aggregate."
                        )
                    ).Add(helper)
                }
                return []GStatement{RawStatement("// lifted recursive local function ${recursiveLift.Name}")}
            }
            if localFunction.Modifiers.Any(SyntaxKind.StaticKeyword) && this.context.GetDeclaredSymbol(
                localFunction
            ) is IMethodSymbol staticLocal &&
                this
                .state
                .LiftedStaticLocalFunctions
                .TryGetValue(staticLocal, out var liftedName) &&
                this
                .state
                .PendingStaticSynthHelpers != nil {
                if !this.state.EmittedLiftedStaticLocalFunctions.Add(staticLocal) {
                    return []GStatement{RawStatement("// lifted static local function $liftedName")}
                }
                let liftedIsAsync = localFunction.Modifiers.Any(SyntaxKind.AsyncKeyword)
                let liftedParameters = this.MapParameters(staticLocal, localFunction.ParameterList, skipFirst: false)
                let liftedReturnType = this.MapDelegateLikeReturnType(
                    staticLocal,
                    liftedIsAsync,
                    localFunction.ReturnType.GetLocation()
                )
                let liftedTypeParameters = this.MapMethodTypeParameters(staticLocal)
                let liftedBody = this.TranslateBody(
                    localFunction,
                    "static local function '${localFunction.Identifier.Text}'"
                )
                this.state.PendingStaticSynthHelpers!!.Add(
                    MethodDeclaration(
                        liftedName,
                        liftedParameters,
                        liftedReturnType,
                        liftedBody,
                        liftedTypeParameters,
                        visibility: Visibility.Private,
                        isAsync: liftedIsAsync,
                        isRefReturn: staticLocal.ReturnsByRef || staticLocal.ReturnsByRefReadonly,
                        isReadOnlyRefReturn: staticLocal.ReturnsByRefReadonly
                    )
                )
                return []GStatement{RawStatement("// lifted static local function $liftedName")}
            }
            if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol refLocalFunction &&
                (
                refLocalFunction.ReturnsByRefReadonly ||
                    (
                    refLocalFunction.ReturnsByRef &&
                        (
                        !refLocalFunction.IsStatic ||
                            refLocalFunction.IsGenericMethod ||
                            this.IsLocalFunctionReferencedAsValue(
                            refLocalFunction,
                            GetLocalFunctionSiblingStatements(localFunction)
                        ) ||
                            this.IsLocalFunctionReferencedFromAnotherSwitchSection(refLocalFunction, localFunction) ||
                            this.IsLocalFunctionReferencedBeforeDeclarationInSwitchSection(
                            refLocalFunction,
                            localFunction
                        )
                    )
                )
            ) {
                let refFunctionName = localFunction.Identifier.Text
                var reason string
                if refLocalFunction.ReturnsByRefReadonly {
                    reason = "ref-readonly local function '$refFunctionName' has no canonical G# function-literal form."
                } else if refLocalFunction.IsGenericMethod {
                    reason = "generic ref-returning local function '$refFunctionName' is not supported by G#'s direct function-literal form."
                } else if !refLocalFunction.IsStatic {
                    reason = "capturing ref-returning local function '$refFunctionName' cannot use G#'s direct function-literal form safely; declare it static or move it to a member."
                } else if this.IsLocalFunctionReferencedFromAnotherSwitchSection(refLocalFunction, localFunction) {
                    reason = "ref-returning local function '$refFunctionName' is referenced from another switch section, where its G# function literal is out of scope."
                } else if this.IsLocalFunctionReferencedBeforeDeclarationInSwitchSection(
                    refLocalFunction,
                    localFunction
                ) {
                    reason = "ref-returning local function '$refFunctionName' is referenced before its declaration in the switch section, where its G# function literal is not yet bound."
                } else {
                    reason = "ref-returning local function '$refFunctionName' cannot be used as a delegate or function value in G#."
                }
                this.context.ReportUnsupported(localFunction, reason)
                return []GStatement{
                    RawStatement("// unsupported: ref-returning local function '${localFunction.Identifier.Text}'")
                }
            }
            // A C# local function maps to a G# local `let` bound to a function
            // literal `func (params) RetType { … }` (NOT an arrow lambda — a local
            // function may be recursive and needs an explicit return type).
            let parameters = List[Parameter]()
            for parameter in localFunction.ParameterList.Parameters {
                parameters.Add(this.MapLambdaParameter(parameter))
            }
            let isAsync = localFunction.Modifiers.Any((m SyntaxToken) -> m.IsKind(SyntaxKind.AsyncKeyword))
            // A local function renders as a `func` literal (NOT an arrow lambda):
            // a value-returning one needs an explicit return type (else the literal
            // is inferred void and `return expr` is rejected), and the explicit type
            // also supports recursion. The declared symbol carries the real return
            // type / void-ness; the async unwrap mirrors method `func`s.
            let localSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(localFunction) as IMethodSymbol
            let returnType = if localSymbol != nil {
                this.MapDelegateLikeReturnType(localSymbol, isAsync, localFunction.ReturnType.GetLocation())
            } else {
                default(GTypeReference?)
            }
            // A local function's body is its own evaluation scope: a spill hoisted
            // while translating it (issue #1731) must never leak into the
            // ENCLOSING statement's prologue (that would evaluate the operand once,
            // eagerly, at the local-function declaration instead of per call). The
            // ambient seam is suspended for the body's translation; each statement
            // inside a block body still opens its own fresh seam via
            // <see cref="TranslateStatement"/>.
            let outerSpillPrologue = this.state.PendingSpillPrologue
            let outerOutDeclarations = this.state.FunctionArgumentOutDeclarations
            let previousBodyScope = this.state.CurrentBodyScope
            this.state.PendingSpillPrologue = nil
            this.state.FunctionArgumentOutDeclarations = nil
            this.state.CurrentBodyScope = localFunction
            var lambda LambdaExpression
            try {
                if localFunction.Body != nil {
                    let innerBody = this.WithParameterShadows(localFunction, this.TranslateBlock(localFunction.Body))
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: innerBody,
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                } else if localFunction.ExpressionBody != nil {
                    // The expression body has no per-statement seam of its own
                    // (unlike a block body — see below), so a nested spill (issue
                    // #1731) must open a fresh seam here via
                    // <see cref="WithSpillSeam"/> — evaluated per call, inside this
                    // very body, rather than being silently dropped by the
                    // enclosing null seam above.
                    let innerBody = if localSymbol?.ReturnsVoid == false {
                        BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return List[GStatement]{
                                        ReturnStatement(
                                            this.TranslateValueWithNullForgiveness(
                                                localFunction.ExpressionBody!!.Expression
                                            ),
                                            isRef: localFunction.ExpressionBody!!.Expression is RefExpressionSyntax
                                        )
                                    }
                                }
                            )
                                .ToList()
                        )
                    } else {
                        BlockStatement(
                            this.WithSpillSeam(
                                func () IReadOnlyList[GStatement] {
                                    return this.TranslateExpressionStatements(
                                        localFunction.ExpressionBody!!.Expression
                                    )!!.ToList()
                                }
                            )
                                .ToList()
                        )
                    }
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: innerBody,
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                } else {
                    lambda = LambdaExpression(
                        parameters,
                        blockBody: BlockStatement(List[GStatement]()),
                        isAsync: isAsync,
                        returnType: returnType,
                        isFunctionLiteral: true,
                        isRefReturn: localSymbol?.ReturnsByRef == true
                    )
                }
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
                this.state.CurrentBodyScope = previousBodyScope
            }
            // Issue #1886: a generic local function (`T First<T>(a, b) { ... }`)
            // carries its type parameters on the `let` binding, not the anonymous
            // function literal (which has no name to hang `[T]` off) — see
            // `let Name[T, U] = func (...) ... { ... }` in G#.
            let typeParameters List[string]? = localFunction
                .TypeParameterList
                ?.Parameters
                .Select((tp TypeParameterSyntax) -> this.EmittedName(tp, tp.Identifier)!!)
                .ToList()
            // Issue #3399: this local participates in a recursive/mutually
            // recursive SCC of capturing local functions — a bare non-recursive
            // `let` binding of the literal cannot reference itself, so gsc loses
            // the binding for every call (GS0130/GS0125). Lower the whole SCC via
            // G#'s nullable-function-local scheme instead: emit the members'
            // nil-initialized `var Name (… -> R)? = nil` declarations exactly once
            // (the first member translated in document order; all declarations
            // must precede the first assignment because a G# closure body cannot
            // reference a not-yet-declared sibling local), then assign this
            // member's function literal to its own local. SCC partners are
            // reached from a closure body through the nullable local via `!!`
            // (see the TranslateIdentifierName/Invocations rewrite). G#'s
            // capture-by-reference closures preserve C#'s shared mutation of the
            // captured sibling locals.
            if localSymbol != nil &&
                this
                .state
                .RecursiveLocalFunctionGroups
                .TryGetValue(localSymbol, out var recursiveBinding) {
                let statements = List[GStatement]()
                if !recursiveBinding.Members.Any(
                    (m IMethodSymbol) -> this.state.EmittedRecursiveGroupMembers.Contains(m)
                ) {
                    recursiveBinding.DeclarationsEmitted = true
                    for member in recursiveBinding.Members {
                        this.state.EmittedRecursiveGroupMembers.Add(member)
                    }
                    statements.AddRange(recursiveBinding.Declarations)
                }
                statements.Add(AssignmentStatement(IdentifierExpression(recursiveBinding.NameOf(localSymbol)), lambda))
                return statements
            }
            return []GStatement{
                LocalFunctionStatement(
                    this.EmittedName(localSymbol, localFunction.Identifier.ValueText),
                    lambda,
                    typeParameters
                )
            }
        }

        shared {
            private func OperationExpression(operation IOperation) ExpressionSyntax? {
                var operation = operation
                if operation is IInstanceReferenceOperation &&
                    operation.IsImplicit == true ||
                    operation is IMethodReferenceOperation {
                    return nil
                }
                if operation is IArgumentOperation argument {
                    return argument.Value.Syntax as ExpressionSyntax
                }
                while operation.IsImplicit && operation.ChildOperations.Count() == 1 {
                    operation = operation.ChildOperations.Single()
                }
                return operation.Syntax as ExpressionSyntax
            }

            private func AssignmentRequiresStatementLowering(
                assignment AssignmentExpressionSyntax
            ) bool -> assignment.Left is TupleExpressionSyntax ||
                (
                assignment.Left is DeclarationExpressionSyntax and {Designation: ParenthesizedVariableDesignationSyntax}
            )

            // Issue #3348: the sub-expressions of `query` that are evaluated EAGERLY, in
            // the scope enclosing the query, rather than inside one of the lambdas its
            // clauses lower to — the first `from`'s source, and every `join`'s `in`
            // source (including those in an `into` continuation's body). C# forbids both
            // from referencing a range variable, so a hoist out of either is safe.
            // Everything else in a query is a clause body and belongs to its own lambda.
            private func EagerQuerySources(query QueryExpressionSyntax) sequence[ExpressionSyntax] {
                yield query.FromClause.Expression
                for var body QueryBodySyntax? = query.Body; body != nil; body = body!!.Continuation?.Body {
                    for clause in body.Clauses {
                        if clause is JoinClauseSyntax join {
                            yield join.InExpression
                        }
                    }
                }
            }

            // Conditional and switch-expression arms own block-expression seams. An
            // enclosing seam must leave each assignment inside its selected arm.
            private func IsInsideConditionalValueBranch(node SyntaxNode, root ExpressionSyntax?) bool {
                for var current SyntaxNode? = node; current != nil && current != root; current = current!!.Parent {
                    let parent SyntaxNode? = current.Parent
                    if parent is ConditionalExpressionSyntax conditional &&
                        (current == conditional.WhenTrue || current == conditional.WhenFalse) {
                        return true
                    }
                    if parent is SwitchExpressionArmSyntax switchArm && current == switchArm.Expression {
                        return true
                    }
                }
                return false
            }

            // True when `node` is reached only through a not-always-evaluated operand
            // inside `root`: the right operand of `&&`/`||`/`??`, or the "when not
            // null" side of a `?.`/`?[...]` conditional-access chain (including any
            // member/element access further chained off it).
            private func IsInShortCircuitedSubexpression(node SyntaxNode, root ExpressionSyntax?) bool {
                for var current SyntaxNode? = node; current != nil && current != root; current = current!!.Parent {
                    let parent SyntaxNode? = current.Parent
                    if parent is BinaryExpressionSyntax binary &&
                        (
                        binary.IsKind(SyntaxKind.LogicalAndExpression) || binary.IsKind(
                            SyntaxKind.LogicalOrExpression
                        ) ||
                            binary.IsKind(SyntaxKind.CoalesceExpression)
                    ) &&
                        current == binary.Right {
                        return true
                    }
                    if parent is ConditionalAccessExpressionSyntax conditionalAccess &&
                        current == conditionalAccess.WhenNotNull {
                        return true
                    }
                }
                return false
            }

            private func CollectEmbeddedPostfix(expression ExpressionSyntax?) List[PostfixUnaryExpressionSyntax] {
                // Collect eagerly evaluated `i++` / `i--` nodes in document order.
                // Conditional/short-circuited operands keep G#'s native inline form.
                return expression!!
                    .DescendantNodes(
                    descendIntoChildren: (node SyntaxNode) -> !(
                        (node is AnonymousFunctionExpressionSyntax || node is LocalFunctionStatementSyntax)
                    )
                )
                    .OfType[PostfixUnaryExpressionSyntax]()
                    .Where(
                    (p PostfixUnaryExpressionSyntax) -> p.IsKind(SyntaxKind.PostIncrementExpression) || p.IsKind(
                        SyntaxKind.PostDecrementExpression
                    )
                )
                    .Where((p PostfixUnaryExpressionSyntax) -> !IsInsideConditionalValueBranch(p, expression))
                    .Where((p PostfixUnaryExpressionSyntax) -> !IsInShortCircuitedSubexpression(p, expression))
                    .ToList()
            }

            // Maps a C# compound-assignment operator token (`+=`, `-=`, …) to its
            // underlying binary operator (`+`, `-`, …), or null for `??=` (which
            // has no side-effect-preserving binary-expression equivalent — see
            // <see cref="FlattenChainedAssignment"/>).
            private func CompoundToBinaryOperator(compoundOp string) string? -> switch compoundOp {
                case "+=": "+"
                case "-=": "-"
                case "*=": "*"
                case "/=": "/"
                case "%=": "%"
                case "&=": "&"
                case "|=": "|"
                case "^=": "^"
                case "<<=": "<<"
                case ">>=": ">>"
                case ">>>=": ">>>"
                default: default(string?)
            }

            private func FindNestedFunction(node SyntaxNode?, body SyntaxNode) SyntaxNode? {
                for var current SyntaxNode? = node; current != nil && current != body; current = current!!.Parent {
                    if current is AnonymousFunctionExpressionSyntax || current is LocalFunctionStatementSyntax {
                        return current
                    }
                }
                return nil
            }

            private func IsDeclaredInNestedFunction(symbol ISymbol?, body SyntaxNode) bool {
                for reference in symbol!!.DeclaringSyntaxReferences {
                    if reference.SyntaxTree != body.SyntaxTree || !body.Span.Contains(reference.Span) {
                        continue
                    }
                    let declaration = reference.GetSyntax()
                    if FindNestedFunction(declaration.Parent, body) != nil {
                        return true
                    }
                }
                return false
            }

            // True when duplicating `expression` in the output has no observable
            // effect — a bare identifier, `this`, literal, or type-name receiver never
            // has a side effect and always denotes the same value/name, so it is safe
            // to embed at more than one output position without spilling it to a temp
            // first (issue #1731). Anything else (a method/property/indexer read, an
            // arithmetic expression, …) may run a side effect or re-read a mutable
            // value and must be evaluated exactly once if it needs to appear more than
            // once.
            private func IsTrivialOperand(expression GExpression) bool -> expression is IdentifierExpression ||
                expression is ThisExpression ||
                expression is LiteralExpression ||
                expression is TypeExpression

            private func CaptureHasExplicitNullableType(symbol ISymbol) bool {
                for reference in symbol.DeclaringSyntaxReferences {
                    let syntax = reference.GetSyntax()
                    let type = (
                        switch syntax {
                            case parameter is ParameterSyntax: parameter.Type
                            case VariableDeclaratorSyntax{
                                Parent: VariableDeclarationSyntax declaration
                            }: declaration.Type
                            default: default(TypeSyntax?)
                        }
                    )!!
                    if type is NullableTypeSyntax {
                        return true
                    }
                }
                return false
            }

            /// Parenthesizes a statement-condition whose printed form would otherwise be
            /// misparsed. A condition ending in an index expression (`… a[i]`) directly
            /// precedes the block's `{`, which the G# parser greedily reads as a
            /// composite-literal initializer (`a[i]{ … }`); wrapping the condition in
            /// parentheses disambiguates it (G# parser limitation; see PR notes).
            private func GuardBlockCondition(condition GExpression) GExpression {
                if condition is ParenthesizedExpression {
                    return condition
                }
                return if EndsWithIndexExpression(condition) {
                    cast[GExpression](ParenthesizedExpression(condition))
                } else {
                    condition
                }
            }

            private func EndsWithIndexExpression(expression GExpression) bool {
                return switch expression {
                    case _ is IndexExpression: true
                    case binary is BinaryExpression: EndsWithIndexExpression(binary.Right)
                    default: false
                }
            }
        }
    }
}
