// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

partial class Binder {
    private func IsSupportedNativeProtocolPayload(concrete TypeSymbol) bool ->
    concrete is not NullableTypeSymbol &&
        concrete is not PlatformTypeSymbol &&
        concrete is not ByRefTypeSymbol &&
        !TypeSymbol.IsByRefLike(concrete) &&
        (
        if concrete is StructSymbol owned {
            !owned.IsGenericDefinition &&
                owned
                .TypeArguments
                .IsDefaultOrEmpty &&
                owned
                .EnclosingTypeArguments
                .IsDefaultOrEmpty &&
                !owned.IsRefStruct &&
                (!owned.IsClass || !owned.IsOpen && !owned.IsSealedHierarchy)
        } else {
            concrete.ClrType is {} imported &&
                !imported.IsGenericType &&
                !imported.IsEnum &&
                !imported.IsInterface &&
                !imported.IsByRefLike &&
                (imported.IsValueType || imported.IsSealed)
        }
    )

    private func CanConvertNativeProtocol(source TypeSymbol, target TypeSymbol) bool {
        let protocol = NativeProtocolOperations.GetProtocol(target)!!
        if NativeProtocolOperations.GetProtocol(source) is {} sourceProtocol {
            return (source is not NullableTypeSymbol || target is NullableTypeSymbol) &&
                NativeProtocolOperations.HasPositiveCoverage($scope, sourceProtocol, protocol)
        }
        if !IsSupportedNativeProtocolPayload(source) {
            return false
        }
        let registry = $scope.GetStructuralAdapterRegistry()
        let imported = registry.ImportedProtocolEntries.FirstOrDefault(
            (entry ImportedNativeProtocolEntry) -> entry.SourceType == source
        )
        if imported != nil {
            return imported.Decisions.TryGetValue(protocol, out var decision) && decision.Positive
        }
        let plan = registry.ProtocolEntries.FirstOrDefault(
            (entry NativeProtocolEntryPlan) -> entry.SourceType == source
        ) ??
            CreateNativeProtocolEntry(nil, source, protocol, default(TextLocation))
        return plan != nil && plan.Protocols.Contains(protocol)
    }

    private func CheckExplicitNativeProtocolConformance(types ImmutableArray[StructSymbol]) {
        for type in types.Where((item StructSymbol) -> !item.NativeProtocols.IsDefaultOrEmpty) {
            let syntax = type.Declaration
            if syntax == nil {
                continue
            }
            let previousTree = $scope.SetCurrentReferencingSyntaxTree(syntax.SyntaxTree)
            let previousPackage = $scope.SetCurrentDeclaringPackage(type.PackageName)
            try {
                if type.IsGenericDefinition ||
                    !type
                    .TypeArguments
                    .IsDefaultOrEmpty ||
                    !type
                    .EnclosingTypeArguments
                    .IsDefaultOrEmpty ||
                    type.IsRefStruct ||
                    type.IsClass &&
                    (type.IsOpen || type.IsSealedHierarchy) {
                    Diagnostics.ReportNativeProtocol(
                        syntax.Location,
                        "explicit conformance requires an exact nongeneric heap-storable class or struct"
                    )
                    continue
                }
                let plan = $scope
                    .GetStructuralAdapterRegistry()
                    .ProtocolEntries
                    .FirstOrDefault((item NativeProtocolEntryPlan) -> item.SourceType == type) ??
                    CreateNativeProtocolEntry(syntax, type, type.NativeProtocols[0], syntax.Location)
                for protocol in type.NativeProtocols {
                    if plan == nil || !plan.Protocols.Contains(protocol) {
                        Diagnostics.ReportNativeProtocol(
                            syntax.Location,
                            "explicit conformance '${type.Name} : ${protocol.Name}' has missing, inaccessible or unsupported exact witnesses"
                        )
                    }
                }
            } finally {
                $scope.SetCurrentReferencingSyntaxTree(previousTree)
                $scope.SetCurrentDeclaringPackage(previousPackage)
            }
        }
    }

    private func BindNativeProtocolConversion(
        location TextLocation,
        source BoundExpression,
        target TypeSymbol,
        testOnly bool = false
    ) BoundExpression {
        let protocol = NativeProtocolOperations.GetProtocol(target)!!
        if source.Type == TypeSymbol.Null && target is NullableTypeSymbol {
            return BoundConversionExpression(source.Syntax, target, source)
        }
        if NativeProtocolOperations.GetProtocol(source.Type) is {} sourceProtocol {
            if source.Type is NullableTypeSymbol && target is not NullableTypeSymbol {
                Diagnostics.ReportNativeProtocol(
                    location,
                    "an absent protocol value cannot initialize a required protocol value"
                )
                return BoundErrorExpression(source.Syntax)
            }
            NativeProtocolOperations.RequireCoverage($scope, sourceProtocol, protocol, location, positive: true)
            return BoundConversionExpression(
                source.Syntax,
                target,
                NativeProtocolOperations.PrepareInput(
                    $scope,
                    source,
                    recoverPayload: false,
                    requirePresent: source.Type is not NullableTypeSymbol
                )
            )
        }
        if source.Type == TypeSymbol.Null ||
            source.Type is NullableTypeSymbol ||
            source.Type is PlatformTypeSymbol ||
            source.Type is ByRefTypeSymbol {
            Diagnostics.ReportNativeProtocol(
                location,
                "native insertion requires a non-null exact payload; nullable/platform payload insertion is not supported"
            )
            return BoundErrorExpression(source.Syntax)
        }
        let concrete = source.Type
        if !IsSupportedNativeProtocolPayload(concrete) {
            Diagnostics.ReportNativeProtocol(
                location,
                "insertion requires an exact nongeneric non-null class or heap-storable struct"
            )
            return BoundErrorExpression(source.Syntax)
        }
        let registry = $scope.GetStructuralAdapterRegistry()
        let importedEntry = registry.ImportedProtocolEntries.FirstOrDefault(
            (candidate ImportedNativeProtocolEntry) -> candidate.SourceType == concrete
        )
        if importedEntry != nil {
            if !importedEntry.Decisions.TryGetValue(protocol, out var decision) {
                Diagnostics.ReportNativeProtocol(
                    location,
                    "unknown canonical imported conformance '${concrete.Name}/${protocol.Name}'"
                )
                return BoundErrorExpression(source.Syntax)
            }
            if !decision.Positive {
                if testOnly {
                    return NativeProtocolOperations.NegativeProbe($scope, source, protocol)
                }
                Diagnostics.ReportNativeProtocol(
                    location,
                    "missing positive canonical imported conformance for '${concrete.Name}/${protocol.Name}'"
                )
                return BoundErrorExpression(source.Syntax)
            }
            let importedCall = BoundClrStaticCallExpression(
                source.Syntax,
                decision.Factory!!,
                protocol,
                ImmutableArray.Create(source)
            )
            return if target == protocol {
                cast[BoundExpression](importedCall)
            } else {
                BoundConversionExpression(source.Syntax, target, importedCall)
            }
        }
        var plan NativeProtocolEntryPlan? = registry.ProtocolEntries.FirstOrDefault(
            (candidate NativeProtocolEntryPlan) -> candidate.SourceType == concrete
        )
        if plan == nil {
            plan = CreateNativeProtocolEntry(source.Syntax, concrete, protocol, location)
        }
        if plan == nil || !plan.Protocols.Contains(protocol) {
            if plan != nil && testOnly {
                return NativeProtocolOperations.NegativeProbe($scope, source, protocol)
            }
            Diagnostics.ReportNativeProtocol(
                location,
                "'${concrete.Name}' does not provide exact accessible witnesses for '${protocol.Name}'"
            )
            return BoundErrorExpression(source.Syntax)
        }
        if NativeProtocolMetadata.IsPublic(protocol) && !NativeProtocolMetadata.IsPublic(concrete) {
            Diagnostics.ReportNativeProtocol(
                location,
                "public native contracts require an accessible exact payload type; private-payload export is not admitted"
            )
            return BoundErrorExpression(source.Syntax)
        }
        let bridge = plan.Bridges.Single((item NativeProtocolBridge) -> item.Protocol == protocol)
        let insertion = BoundCallExpression(source.Syntax, bridge.Factory, ImmutableArray.Create(source))
        return if target == protocol {
            cast[BoundExpression](insertion)
        } else {
            BoundConversionExpression(source.Syntax, target, insertion)
        }
    }

    private func CreateNativeProtocolEntry(
        syntax SyntaxNode?,
        concrete TypeSymbol,
        required TypeSymbol,
        location TextLocation
    ) NativeProtocolEntryPlan? {
        let registry = $scope.GetStructuralAdapterRegistry()
        let entry = StructSymbol(
            "<>ProtocolEntry${registry.Counter++}",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Internal,
            declaration: nil,
            concrete.ContainingNamespace ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: true
        )
        let saved = FieldSymbol("<>saved", concrete, Accessibility.Private, isReadOnly: !concrete.IsValueType)
        entry.SetInstanceFieldsAndPrimaryConstructorParameters(
            ImmutableArray.Create(saved),
            ImmutableArray.Create(ParameterSymbol(saved.Name, concrete))
        )
        let protocols = ImmutableArray.CreateBuilder[TypeSymbol]()
        let decisions = List[NativeProtocolDecision]()
        let methods = ImmutableArray.CreateBuilder[FunctionSymbol]()
        let candidates = List[TypeSymbol]()
        var current BoundScope? = $scope
        while current != nil {
            candidates.AddRange(current.GetDeclaredInterfaces().Where((item InterfaceSymbol) -> item.IsProtocol))
            current = current.Parent
        }
        if $scope.References is {} references {
            for assembly in references.Assemblies {
                for imported in NativeProtocolMetadata.Read(assembly).Protocols {
                    if imported.IsVisible {
                        candidates.Add(
                            TypeSymbol.FromClrTypeWithoutNullability(imported, NullabilityFreeReason.ResolvedTypeName)
                        )
                    }
                }
            }
        }
        candidates.Add(required)
        for protocol in candidates
            .Distinct()
            .OrderBy((item TypeSymbol) -> item.ToDisplayString(DisplayFormat.FullyQualified), StringComparer.Ordinal)
            .ThenBy((item TypeSymbol) -> item.ClrType?.Assembly.FullName ?? string.Empty, StringComparer.Ordinal) {
            let selected = List[
                (
                    Slot FunctionSymbol,
                    Target FunctionSymbol?,
                    ImportedTarget MethodInfo?,
                    ImportedSlot MethodInfo?,
                    Extension bool
                )
            ]()
            var supported = true
            let slots = (
                if protocol is InterfaceSymbol owned {
                    owned.Methods.Select((slot FunctionSymbol) -> (Slot: slot, ImportedSlot: default(MethodInfo?)))
                } else {
                    protocol.ClrType!!.GetMethods().Select(
                        (slot MethodInfo) -> (
                            Slot: CreateImportedAdapterContractMethod(slot, protocol),
                            ImportedSlot: cast[MethodInfo?](slot)
                        )
                    )
                }
            ).ToImmutableArray()
            let contractSlots = slots.Select((item(Slot FunctionSymbol, ImportedSlot MethodInfo?)) -> item.Slot)
                .ToImmutableArray()
            for (slot, importedSlot) in slots {
                if concrete.ClrType is {} importedSource {
                    let importedInstances = MemberLookup
                        .SafeGetMethodsIncludingSelfAndInterfaces(importedSource, slot.Name)
                        .Where(
                        (method MethodInfo) -> method.IsPublic &&
                            !method.IsStatic &&
                            ImportedMethodMetadataSupported(method) &&
                            NativeProtocolSignaturesMatch(
                            slot,
                            CreateImportedAdapterContractMethod(method, concrete),
                            0
                        )
                    )
                        .ToArray()
                    if importedInstances.Length > 1 {
                        Diagnostics.ReportNativeProtocol(
                            location,
                            "ambiguous imported instance witness for '${protocol.Name}.${slot.Name}'"
                        )
                        return nil
                    }
                    if importedInstances.Length == 1 {
                        selected.Add((slot, nil, importedInstances[0], importedSlot, false))
                        continue
                    }
                }
                let instances = TypeMemberModel
                    .GetMethods(concrete, slot.Name, MemberQuery.Instance(MemberKinds.Method))
                    .Where(
                    (method FunctionSymbol) -> method.Accessibility == Accessibility.Public &&
                        method.ExplicitInterfaceClauseTarget == nil &&
                        NativeProtocolSignaturesMatch(slot, method, 0)
                )
                    .ToImmutableArray()
                if instances.Length > 1 {
                    Diagnostics.ReportNativeProtocol(
                        location,
                        "ambiguous instance witness for '${protocol.Name}.${slot.Name}'"
                    )
                    return nil
                }
                if instances.Length == 1 {
                    selected.Add((slot, instances[0], nil, importedSlot, false))
                    continue
                }
                let extensions = $scope
                    .TryLookupExtensionFunctions(concrete, slot.Name)
                    .Where(
                    (method FunctionSymbol) -> method.Accessibility == Accessibility.Public &&
                        method
                        .Parameters
                        .Length > 0 &&
                        method
                        .Parameters[0]
                        .RefKind == RefKind.None &&
                        method
                        .Parameters[0]
                        .Type == concrete &&
                        NativeProtocolSignaturesMatch(slot, method, 1)
                )
                    .Distinct()
                    .ToImmutableArray()
                let importedExtensionCandidates = memberLookup
                    .CollectImportedExtensionMethods(slot.Name)
                    .Where(
                    (method MethodInfo) -> method.IsPublic &&
                        method.IsStatic &&
                        method
                        .DeclaringType
                        ?.IsVisible == true &&
                        method
                        .GetParameters().Length > 0
                )
                    .ToArray()
                let importedExtensions = importedExtensionCandidates
                    .Where((method MethodInfo) -> ImportedMethodMetadataSupported(method) && !method.IsGenericMethod)
                    .Select(
                    (method MethodInfo) -> (
                        Method: method,
                        Symbol: CreateImportedAdapterContractMethod(
                            method,
                            TypeSymbol.FromClrTypeWithoutNullability(
                                method.DeclaringType!!,
                                NullabilityFreeReason.ResolvedTypeName
                            )
                        )
                    )
                )
                    .Where(
                    (item(Method MethodInfo, Symbol FunctionSymbol)) ->
                    item
                        .Symbol
                        .Parameters[0]
                        .RefKind == RefKind.None &&
                        item
                        .Symbol
                        .Parameters[0]
                        .Type == concrete &&
                        NativeProtocolSignaturesMatch(slot, item.Symbol, 1)
                )
                    .ToArray()
                if extensions.Length + importedExtensions.Length > 1 {
                    Diagnostics.ReportNativeProtocol(
                        location,
                        "ambiguous extension witness for '${protocol.Name}.${slot.Name}'"
                    )
                    return nil
                }
                if importedExtensions.Length == 1 {
                    selected.Add((slot, importedExtensions[0].Symbol, importedExtensions[0].Method, importedSlot, true))
                    continue
                }
                if extensions.Length == 0 {
                    let unsupported = TypeMemberModel.GetMethods(
                        concrete,
                        slot.Name,
                        MemberQuery.Instance(MemberKinds.Method)
                    )
                        .Any(
                        (method FunctionSymbol) -> method.Accessibility == Accessibility.Public &&
                            (
                            method.IsAsyncOrSuspending ||
                                method.IsGeneric ||
                                method.ReturnRefKind != RefKind.None ||
                                method
                                .Parameters
                                .Any((parameter ParameterSymbol) -> parameter.RefKind != RefKind.None)
                        )
                    ) ||
                        $scope
                        .TryLookupExtensionFunctions(concrete, slot.Name).Any(
                        (method FunctionSymbol) -> method.Accessibility == Accessibility.Public &&
                            (
                            method.IsAsyncOrSuspending ||
                                method.IsGeneric ||
                                method.ReturnRefKind != RefKind.None ||
                                method
                                .Parameters
                                .Any((parameter ParameterSymbol) -> parameter.RefKind != RefKind.None)
                        )
                    ) ||
                        concrete.ClrType is {} importedConcrete &&
                        MemberLookup
                        .SafeGetMethodsIncludingSelfAndInterfaces(importedConcrete, slot.Name).Any(
                        (method MethodInfo) -> method.IsPublic &&
                            !method.IsStatic &&
                            (
                            !ImportedMethodMetadataSupported(method) ||
                                method.IsGenericMethod ||
                                method
                                .ReturnType
                                .IsByRef ||
                                method
                                .GetParameters().Any((parameter ParameterInfo) -> parameter.ParameterType.IsByRef)
                        )
                    ) ||
                        concrete.ClrType is {} importedReceiver &&
                        importedExtensionCandidates
                        .Any(
                        (method MethodInfo) -> {
                            let receiver = method.GetParameters()[0].ParameterType
                            let shape = if receiver.IsByRef {
                                receiver.GetElementType()
                            } else {
                                receiver
                            }
                            // An open receiver may apply after inference; it is not negative evidence.
                            return shape != nil &&
                                (
                                shape.ContainsGenericParameters || ClrTypeUtilities.AreSame(shape, importedReceiver)
                            ) &&
                                (
                                !ImportedMethodMetadataSupported(method) ||
                                    method.IsGenericMethod ||
                                    method
                                    .ReturnType
                                    .IsByRef ||
                                    method
                                    .GetParameters().Any((parameter ParameterInfo) -> parameter.ParameterType.IsByRef)
                            )
                        }
                    )
                    if unsupported {
                        Diagnostics.ReportNativeProtocol(
                            location,
                            "unsupported witness signature for '${protocol.Name}.${slot.Name}'"
                        )
                        return nil
                    }
                    supported = false
                    break
                }
                selected.Add((slot, extensions[0], nil, importedSlot, true))
            }
            if !supported {
                decisions.Add(
                    NativeProtocolDecision(protocol, false, ImmutableArray[NativeProtocolWitness].Empty, contractSlots)
                )
                continue
            }
            decisions.Add(
                NativeProtocolDecision(
                    protocol,
                    true,
                    selected.Select(
                        (
                            witness(
                                Slot FunctionSymbol,
                                Target FunctionSymbol?,
                                ImportedTarget MethodInfo?,
                                ImportedSlot MethodInfo?,
                                Extension bool
                            )
                        ) ->
                        NativeProtocolWitness(witness.Slot, witness.Target, witness.ImportedTarget, witness.Extension)
                    )
                        .ToImmutableArray(),
                    contractSlots
                )
            )
            protocols.Add(protocol)
            for witness in selected {
                let generated = if protocol is InterfaceSymbol ownedProtocol {
                    if witness.ImportedTarget is {} importedTarget {
                        CreateUserTargetImportedSourceAdapterMethod(
                            syntax ?? ownedProtocol.Declaration,
                            entry,
                            saved,
                            concrete,
                            false,
                            witness.Slot,
                            ownedProtocol,
                            importedTarget
                        )
                    } else {
                        CreateUserAdapterMethod(
                            syntax ?? ownedProtocol.Declaration,
                            entry,
                            saved,
                            concrete,
                            false,
                            witness.Slot,
                            ownedProtocol,
                            witness.Target!!
                        )
                    }
                } else {
                    if witness.ImportedTarget is {} importedTarget {
                        CreateImportedAdapterMethod(
                            entry,
                            saved,
                            concrete,
                            false,
                            witness.ImportedSlot!!,
                            protocol,
                            importedTarget
                        )
                    } else {
                        CreateImportedTargetUserSourceAdapterMethod(
                            entry,
                            saved,
                            concrete,
                            false,
                            witness.ImportedSlot!!,
                            protocol,
                            witness.Target!!
                        )
                    }
                }
                methods.Add(generated.Method)
                if witness.Extension {
                    let receiver = AdapterSourceReceiver(entry, generated.Method, saved, concrete, handleMode: false)
                    let arguments = ImmutableArray.Create(receiver).AddRange(
                        generated
                            .Method
                            .Parameters
                            .Select(
                            (parameter ParameterSymbol) -> cast[BoundExpression](
                                BoundVariableExpression(syntax, parameter)
                            )
                        )
                    )
                    let call BoundExpression = if witness.ImportedTarget is {} importedExtension {
                        BoundClrStaticCallExpression(syntax, importedExtension, witness.Slot.Type, arguments)
                    } else {
                        BoundCallExpression(syntax, witness.Target!!, arguments)
                    }
                    registry.MethodBodies[generated.Method] = AdapterMethodBody(call, witness.Slot.Type, RefKind.None)
                } else {
                    registry.MethodBodies[generated.Method] = generated.Body
                }
            }
        }
        entry.SetInterfaces(protocols.OfType[InterfaceSymbol]().ToImmutableArray())
        entry.SetImplementedClrInterfaces(
            protocols.Where((item TypeSymbol) -> item is not InterfaceSymbol).ToImmutableArray()
        )
        let recover = FunctionSymbol(
            "<>Recover",
            ImmutableArray[ParameterSymbol].Empty,
            concrete,
            declaration: nil,
            $package: nil,
            Accessibility.Internal,
            entry
        )
        let savedRead = AdapterSourceReceiver(entry, recover, saved, concrete, handleMode: false)
        registry.MethodBodies[recover] = AdapterMethodBody(savedRead, concrete, RefKind.None)
        methods.Add(recover)
        entry.SetMethods(methods.ToImmutable())
        let plan = NativeProtocolEntryPlan(concrete, entry, saved, protocols.ToImmutable(), recover)
        plan.Decisions.AddRange(decisions)
        entry.NativeProtocolEntry = plan
        registry.ProtocolEntries.Add(plan)
        registry.Types.Add(entry)
        CreateNativeProtocolBridges(plan, registry)
        return plan
    }

    shared {
        private func CreateNativeProtocolBridges(plan NativeProtocolEntryPlan, registry StructuralAdapterRegistry) {
            let support = StructSymbol(
                "<>ProtocolBridges${registry.Counter++}",
                ImmutableArray[FieldSymbol].Empty,
                if NativeProtocolMetadata.IsPublic(plan.SourceType) && plan.Protocols.Any(
                    (protocol TypeSymbol) -> NativeProtocolMetadata.IsPublic(protocol)
                ) {
                    Accessibility.Public
                } else {
                    Accessibility.Internal
                },
                declaration: nil,
                plan.Entry.PackageName,
                isData: false,
                isInline: false,
                isClass: true
            )
            let methods = ImmutableArray.CreateBuilder[FunctionSymbol]()
            support.IsNativeProtocolSupport = true
            for var index = 0; index < plan.Protocols.Length; index++ {
                let protocol = plan.Protocols[index]
                let accessibility = if NativeProtocolMetadata.IsPublic(protocol) && NativeProtocolMetadata.IsPublic(
                    plan.SourceType
                ) {
                    Accessibility.Public
                } else {
                    Accessibility.Internal
                }
                let factory = FunctionSymbol(
                    "Create${index}",
                    ImmutableArray.Create(ParameterSymbol("value", plan.SourceType)),
                    protocol,
                    declaration: nil,
                    $package: nil,
                    accessibility
                )
                let factoryBody = BoundConversionExpression(
                    nil,
                    protocol,
                    BoundConstructorCallExpression(
                        nil,
                        plan.Entry,
                        ImmutableArray.Create[BoundExpression](BoundVariableExpression(nil, factory.Parameters[0]))
                    )
                )
                registry.MethodBodies[factory] = AdapterMethodBody(factoryBody, protocol, RefKind.None)
                if !plan.SourceType.IsValueType {
                    let value = BoundVariableExpression(nil, factory.Parameters[0])
                    let empty = BoundLiteralExpression(nil, nil, TypeSymbol.Null)
                    let absent = BoundIsExpression(nil, value, BoundConstantPattern(nil, value.Type, empty))
                    registry.MethodBodies[factory] = Lowerer.Lower(
                        BoundBlockStatement(
                            nil,
                            ImmutableArray.Create(
                                cast[BoundStatement](
                                    BoundIfStatement(
                                        nil,
                                        absent,
                                        NativeProtocolOperations.InvalidBoundary(
                                            "A native protocol insertion payload is absent"
                                        ),
                                        nil
                                    )
                                ),
                                cast[BoundStatement](BoundReturnStatement(nil, factoryBody))
                            )
                        )
                    )
                }
                let matches = FunctionSymbol(
                    "Matches${index}",
                    ImmutableArray.Create(ParameterSymbol("value", NullableTypeSymbol.Get(protocol))),
                    TypeSymbol.Bool,
                    declaration: nil,
                    $package: nil,
                    accessibility
                )
                registry.MethodBodies[matches] = AdapterMethodBody(
                    BoundIsExpression(nil, BoundVariableExpression(nil, matches.Parameters[0]), plan.Entry),
                    TypeSymbol.Bool,
                    RefKind.None
                )
                let recover = FunctionSymbol(
                    "Recover${index}",
                    ImmutableArray.Create(ParameterSymbol("value", protocol)),
                    plan.SourceType,
                    declaration: nil,
                    $package: nil,
                    accessibility
                )
                registry.MethodBodies[recover] = AdapterMethodBody(
                    BoundUserInstanceCallExpression(
                        nil,
                        BoundConversionExpression(nil, plan.Entry, BoundVariableExpression(nil, recover.Parameters[0])),
                        plan.Recover,
                        ImmutableArray[BoundExpression].Empty,
                        plan.SourceType
                    ),
                    plan.SourceType,
                    RefKind.None
                )
                let recovery = registry.MethodBodies[recover]
                registry.MethodBodies[recover] = Lowerer.Lower(
                    BoundBlockStatement(
                        nil,
                        ImmutableArray.Create[BoundStatement](
                            BoundIfStatement(
                                nil,
                                BoundIsExpression(nil, BoundVariableExpression(nil, recover.Parameters[0]), plan.Entry),
                                recovery,
                                NativeProtocolOperations.InvalidBoundary("Invalid native protocol extraction evidence")
                            )
                        )
                    )
                )
                methods.Add(factory)
                methods.Add(matches)
                methods.Add(recover)
                plan.Bridges.Add(NativeProtocolBridge(protocol, factory, matches, recover))
            }
            support.SetStaticMethods(methods.ToImmutable())
            for method in methods {
                method.IsStatic = true
                method.StaticOwnerType = support
            }
            plan.BridgeType = support
            registry.Types.Add(support)
        }

        private func NativeProtocolSignaturesMatch(slot FunctionSymbol, candidate FunctionSymbol, offset int32) bool {
            if candidate.IsAsyncOrSuspending ||
                candidate
                .TypeParameters
                .Length != 0 ||
                slot
                .Parameters
                .Length +
                offset != candidate
                .Parameters
                .Length ||
                !NativeProtocolMetadata.TypesMatch(slot.Type, candidate.Type) ||
                slot.ReturnRefKind != RefKind.None ||
                candidate.ReturnRefKind != RefKind.None {
                return false
            }
            for var index = 0; index < slot.Parameters.Length; index++ {
                if !NativeProtocolMetadata.TypesMatch(
                    slot.Parameters[index].Type,
                    candidate.Parameters[index + offset].Type
                ) ||
                    slot
                    .Parameters[index]
                    .RefKind != RefKind.None ||
                    candidate
                    .Parameters[index + offset]
                    .RefKind != RefKind.None {
                    return false
                }
            }
            return true
        }
    }
}
