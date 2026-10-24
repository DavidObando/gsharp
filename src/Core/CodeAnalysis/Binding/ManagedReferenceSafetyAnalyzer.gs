// <copyright file="ManagedReferenceSafetyAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// Checks initialization and segment-local borrowed adapters without changing their ABI.
internal class ManagedReferenceSafetyAnalyzer : BoundTreeWalker {
    private let diagnostics DiagnosticBag
    private let required Dictionary[TypeSymbol, TypeSymbol?] = Dictionary[TypeSymbol, TypeSymbol?]()
    private let managedLocations HashSet[VariableSymbol] = HashSet[VariableSymbol]()
    private let analyzedFunctions HashSet[
        (Function FunctionSymbol, InitializerOwner StructSymbol?, InitializerAnchor SyntaxNode?)
    ] = HashSet[(Function FunctionSymbol, InitializerOwner StructSymbol?, InitializerAnchor SyntaxNode?)]()
    private let activeInitializers HashSet[(Owner StructSymbol, Initializer BoundExpression)] = HashSet[
        (Owner StructSymbol, Initializer BoundExpression)
    ]()
    private let completedInitializers HashSet[
        (
            Definition StructSymbol,
            Owner StructSymbol,
            Initializer BoundExpression,
            Anchor SyntaxNode?,
            ResultOverwritten bool,
            StateMachine bool
        )
    ] = HashSet[
        (
            Definition StructSymbol,
            Owner StructSymbol,
            Initializer BoundExpression,
            Anchor SyntaxNode?,
            ResultOverwritten bool,
            StateMachine bool
        )
    ]()
    private var initializerOwner StructSymbol?
    private var initializerAnchor SyntaxNode?
    private var overwrittenInitializerResult BoundExpression?
    private var analyzingStateMachine bool
    private var analyzingNativeSupport bool

    private init(diagnostics DiagnosticBag) {
        this.diagnostics = diagnostics
    }

    internal prop InitializerVisitCount int32 {
        get;
        private set;
    }

    override func VisitExpression(node BoundExpression?) {
        if node != nil && !this.analyzingNativeSupport {
            NativeProtocolSafety.ValidateExpression(node, this.diagnostics, this.initializerAnchor)
        }
        switch node {
            case literal is BoundFunctionLiteralExpression {
                this.AnalyzeFunction(literal.Function, literal.Body)
                return
            }
            case value is BoundDefaultExpression when this.RequiredHandle(this.InitializerType(value.Type)) != nil {
                this.ReportRequired(
                    value,
                    this.InitializerType(value.Type),
                    "default would synthesize a null non-null managed-reference slot; use a nullable handle or initialize the aggregate"
                )
            }
            case literal is BoundStructLiteralExpression {
                if literal.CopySource == nil {
                    this.CheckConstruction(
                        literal.StructType,
                        literal,
                        literal.Initializers.Select((i BoundFieldInitializer) -> i.Field ?? i.Property?.BackingField),
                        explicitConstructor: false
                    )
                }
                for initializer in literal.Initializers {
                    this.CheckScopedStore(initializer.Value)
                }
            }
            case map_ is BoundMapLiteralExpression {
                for entry in map_.Entries {
                    this.CheckScopedStore(entry.Key)
                    this.CheckScopedStore(entry.Value)
                }
            }
            case call is BoundConstructorCallExpression {
                this.CheckConstruction(
                    call.StructType,
                    call,
                    Enumerable.Empty[FieldSymbol?](),
                    call.SelectedConstructor != nil
                )
                this.CheckConstructorArguments(call.Arguments, call.SelectedConstructor)
            }
            case chaining is BoundConstructorChainingExpression {
                this.CheckConstructorArguments(chaining.Arguments, chaining.SelectedConstructor)
            }
            case array is BoundArrayCreationExpression {
                if this.RequiredHandle(this.InitializerType(array.ElementType)) != nil &&
                    !array
                    .DimensionExpressions
                    .Any((dimension BoundExpression) -> dimension.ConstantValue is {HasValue: true, Value: 0}) &&
                    (
                    array.LengthExpression != nil ||
                        (array.ContainerType is ArrayTypeSymbol fixedArray && fixedArray.Length > array.Elements.Length)
                ) {
                    this.ReportRequired(
                        array,
                        this.InitializerType(array.ElementType),
                        "array initialization must supply every non-null managed-reference element"
                    )
                }
                for element in array.Elements {
                    this.CheckScopedStore(element)
                }
            }
            case field is BoundFieldAssignmentExpression {
                this.CheckScopedStore(field.Value, field)
                this.CheckSuspendingLocation(field.ReceiverExpression ?? VariableReceiver(field.Receiver), field.Value)
            }
            case property is BoundPropertyAssignmentExpression {
                this.CheckScopedStore(property.Value, property)
                this.CheckSuspendingLocation(property.Receiver, property.Value, captureReferenceOwners: true)
            }
            case property is BoundClrPropertyAssignmentExpression {
                this.CheckScopedStore(property.Value, property)
                this.CheckSuspendingLocation(property.Receiver, property.Value, captureReferenceOwners: true)
            }
            case index is BoundIndexAssignmentExpression {
                this.CheckScopedStore(index.Value, index)
                for argument in index.Indices {
                    this.CheckScopedStore(argument)
                }
            }
            case index is BoundClrIndexAssignmentExpression {
                this.CheckScopedStore(index.Value, index)
                for argument in index.Arguments {
                    this.CheckScopedStore(argument)
                    this.CheckSuspendingLocation(index.TargetExpression ?? VariableReceiver(index.Target), argument)
                }
                this.CheckSuspendingLocation(index.TargetExpression ?? VariableReceiver(index.Target), index.Value)
            }
            case constructor is BoundClrConstructorCallExpression {
                this.CheckConstructorArguments(constructor.Arguments, constructor: nil)
            }
            case globalAssignment is BoundAssignmentExpression when globalAssignment.Variable is not(
                LocalVariableSymbol and {RefKind: RefKind.None}
            ) {
                this.CheckScopedStore(globalAssignment.Expression, globalAssignment)
            }
            case indirect is BoundIndirectAssignmentExpression {
                this.CheckScopedStore(indirect.Value, indirect)
            }
            case indirect is BoundIndirectCallExpression {
                this.CheckArguments(indirect.Arguments)
            }
            case pointer is BoundFunctionPointerInvocationExpression {
                this.CheckArguments(pointer.Arguments)
            }
            case BoundMethodGroupExpression{Receiver: {} receiver} {
                this.CheckDelegateTarget(receiver)
            }
            case BoundClrMethodGroupExpression{Receiver: {} receiver} {
                this.CheckDelegateTarget(receiver)
            }
            case baseCall is BoundBaseClassCallExpression {
                this.CheckArguments(baseCall.Arguments, baseCall.Method, baseCall.Receiver)
            }
            case index is BoundClrIndexExpression {
                this.CheckArguments(index.Arguments, receiver: index.Target)
            }
            case binary is BoundClrBinaryOperatorExpression when !IsManagedReferenceEquality(binary) {
                this.CheckArguments(ImmutableArray.Create(binary.Left, binary.Right), binary.Function)
            }
            case unary is BoundClrUnaryOperatorExpression {
                this.CheckArguments(ImmutableArray.Create(unary.Operand))
            }
            case conversion is BoundClrConversionCallExpression {
                this.CheckArguments(ImmutableArray.Create(conversion.Source), conversion.Function)
            }
        }
        if node is BoundCallOperationExpression operation {
            let receiver = switch operation {
                case call is BoundImportedInstanceCallExpression when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(
                    call.Receiver,
                    RefCapabilities.IsReadOnlyMethod(call.Method)
                ): call.Receiver
                case call is BoundUserInstanceCallExpression when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(
                    call.Receiver
                ): call.Receiver
                case call is BoundBaseInterfaceCallExpression when !RefCapabilities.RequiresReadOnlyReceiverDefensiveCopy(
                    call.Receiver
                ): call.Receiver
                default: default(BoundExpression?)
            }
            this.CheckArguments(operation.Arguments, operation.CalledFunction as FunctionSymbol, receiver)
        }
        if node is BoundIndirectAssignmentExpression assignment && this.IsManagedLocation(assignment.Pointer) &&
            AsyncBoundTreeQueries
            .HasAwait(assignment.Value) {
            this.Report(
                assignment,
                "a borrowed write cannot survive suspension; evaluate the value before selecting the borrow"
            )
        }
        if node?.Type is TupleTypeSymbol && ManagedReferenceOrigins.IsScopedHandle(node!!) {
            this.Report(node!!, "a scoped managed-reference value cannot be stored in an aggregate")
        }
        base.VisitExpression(node)
    }

    protected override func VisitVariableDeclaration(node BoundVariableDeclaration) {
        if this.analyzingStateMachine && ManagedReferenceOrigins.IsScopedHandle(node.Variable) {
            this.Report(node, "a scoped managed-reference local cannot be retained by a state machine")
        }
        if node.Initializer != nil && node.Variable is GlobalVariableSymbol {
            this.CheckScopedStore(node.Initializer, node)
        }
        if node.Initializer != nil && this.IsManagedLocation(node.Initializer) &&
            (
            node
                .Variable
                .Type is ByRefTypeSymbol ||
                (node.Variable is LocalVariableSymbol and {RefKind: not RefKind.None})
        ) {
            this.managedLocations.Add(node.Variable)
        }
        if node.Initializer is BoundDefaultExpression &&
            node.Variable is LocalVariableSymbol &&
            (node.Syntax is VariableDeclarationSyntax and {Initializer: nil}) &&
            ManagedReferenceTypes
            .TryGetElement(node.Variable.Type, out _, out _) {
            // The existing definite-assignment pass checks every use.
            return
        }
        base.VisitVariableDeclaration(node)
    }

    protected override func VisitYieldStatement(node BoundYieldStatement) {
        this.CheckScopedStore(node.Expression)
        base.VisitYieldStatement(node)
    }

    protected override func VisitThrowStatement(node BoundThrowStatement) {
        if !this.analyzingNativeSupport {
            NativeProtocolSafety.ValidateThrow(
                node.Expression,
                (this.initializerAnchor ?? node.Syntax)?.Location ?? default(TextLocation),
                this.diagnostics
            )
        }
        base.VisitThrowStatement(node)
    }

    private func AnalyzeFunction(function FunctionSymbol, body BoundBlockStatement) {
        if !this.analyzedFunctions.Add((function, this.initializerOwner, this.initializerAnchor)) {
            return
        }
        let previous = this.analyzingStateMachine
        let previousNativeSupport = this.analyzingNativeSupport
        this.analyzingNativeSupport = function.StaticOwnerType is StructSymbol{IsNativeProtocolSupport: true}
        if !this.analyzingNativeSupport {
            NativeProtocolSafety.ValidateSignature(function, this.diagnostics)
        }
        this.analyzingStateMachine = function.IsAsyncOrSuspending || IteratorDetection.ContainsYield(body)
        if this.analyzingStateMachine {
            for parameter in function.Parameters {
                if ManagedReferenceOrigins.IsScopedHandle(parameter) {
                    this.diagnostics.ReportManagedReference(
                        Invariant.Required(
                            parameter.DeclaringSyntax ?? function.Declaration,
                            "source parameters have a declaration",
                            expression: "parameter.DeclaringSyntax ?? function.Declaration"
                        )
                            .Location,
                        "a scoped managed-reference parameter cannot be retained by a state machine"
                    )
                }
            }
        }
        this.Visit(body)
        this.analyzingStateMachine = previous
        this.analyzingNativeSupport = previousNativeSupport
    }

    private func CheckArguments(
        arguments ImmutableArray[BoundExpression],
        target FunctionSymbol? = nil,
        receiver BoundExpression? = nil
    ) {
        var borrowed = false
        for var i = 0; i < arguments.Length; i++ {
            let argument = arguments[i]
            if ManagedReferenceOrigins.IsScopedHandle(argument) &&
                !(
                target != nil && i < target.Parameters.Length && ManagedReferenceOrigins.IsScopedHandle(
                    target.Parameters[i]
                )
            ) {
                this.Report(argument, "a scoped managed-reference value requires a scoped parameter")
            }
            this.CheckSuspendingLocation(receiver, argument)
            if borrowed && AsyncBoundTreeQueries.HasAwait(argument) {
                this.Report(
                    argument,
                    "a borrowed argument cannot survive a later suspension; evaluate the suspending value before selecting the borrow"
                )
            }
            borrowed |= argument.Type is ByRefTypeSymbol && this.IsManagedLocation(argument)
        }
    }

    private func CheckDelegateTarget(receiver BoundExpression) {
        if ManagedReferenceOrigins.IsScopedHandle(receiver) {
            this.Report(receiver, "a scoped managed-reference receiver cannot be captured as a delegate target")
        }
    }

    private func CheckBaseInitializer(initializer BaseConstructorInitializer?) {
        if initializer == nil {
            return
        }
        if initializer.ClrConstructor is {} imported {
            NativeProtocolSafety.ValidateForeignCall(
                imported,
                initializer.Arguments.Any(
                    (argument BoundExpression) -> NativeProtocolSafety.ContainsSavedProtocol(argument.Type)
                ),
                initializer.Arguments.FirstOrDefault()?.Syntax?.Location ?? default(TextLocation),
                diagnostics
            )
        }
        this.CheckConstructorArguments(initializer.Arguments, initializer.GSharpConstructor)
        for argument in initializer.Arguments {
            this.VisitExpression(argument)
        }
    }

    private func CheckConstructorArguments(arguments ImmutableArray[BoundExpression], constructor ConstructorSymbol?) {
        if constructor != nil && constructor.IsSynthesizedFromPrimaryConstructor == false {
            this.CheckArguments(arguments, constructor.Function)
            return
        }
        for argument in arguments {
            this.CheckScopedStore(argument)
        }
        this.CheckArguments(arguments, constructor?.Function)
    }

    private func CheckPrimaryConstructorParameters(type StructSymbol) {
        for parameter in type.PrimaryConstructorParameters {
            if !ManagedReferenceOrigins.IsScopedHandle(parameter) {
                continue
            }
            this.diagnostics.ReportManagedReference(
                Invariant.Required(
                    parameter.DeclaringSyntax ?? type.Declaration,
                    "source primary parameters have a declaration",
                    expression: "parameter.DeclaringSyntax ?? type.Declaration"
                )
                    .Location,
                "a scoped managed-reference primary-constructor parameter would be stored in an instance field"
            )
        }
    }

    private func CheckRequiredConstructorPaths(
        type StructSymbol,
        fields ImmutableArray[FieldSymbol],
        functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder
    ) {
        for constructor in type.ExplicitConstructors {
            if constructor.IsConvenience {
                continue
            }
            if constructor.IsSynthesizedFromPrimaryConstructor {
                this.CheckImplicitConstructorPath(type, fields)
            } else if functions.TryGetValue(constructor.Function, out var body) {
                let projection = ConstructorAssignmentProjection(type, constructor, fields, this)
                DefiniteAssignmentAnalyzer.Analyze(projection.Project(body), constructor.Function, this.diagnostics)
            }
        }
        // A positional value-type default constructor is a zero-storage helper,
        // not the primary initialization path. Its uses are checked below with
        // zero provenance, without crediting ordinary declared initializers.
        if (type.ExplicitConstructors.IsDefaultOrEmpty && type.IsClass) ||
            (
            type.NeedsSynthesizedValueStructDefaultCtor &&
                !type.ValueStructDefaultCtorIsZeroInitialization &&
                type.LiteralInitializerMarkerCount == 0
        ) {
            this.CheckImplicitConstructorPath(type, fields)
        }
    }

    private func CheckRequiredStaticPaths(type StructSymbol, fields ImmutableArray[FieldSymbol]) {
        let function = FunctionSymbol(
            "<static-initializer>",
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            declaration: nil
        ){IsStatic = true, StaticOwnerType = type, IsStaticInitializer = true}
        let projection = StaticAssignmentProjection(type, fields, this)
        DefiniteAssignmentAnalyzer.Analyze(
            projection.Project(type.StaticInitializerStatements),
            function,
            this.diagnostics
        )
    }

    private func CheckImplicitConstructorPath(
        type StructSymbol,
        fields ImmutableArray[FieldSymbol],
        zeroValue BoundStructLiteralExpression? = nil,
        requireInitializedResult bool = true
    ) {
        if zeroValue != nil {
            let validatedInitializers = type.NeedsSynthesizedValueStructDefaultCtor &&
                !type.ValueStructDefaultCtorIsZeroInitialization
            let declaredStorage Dictionary[FieldSymbol, TypeSymbol]? = if validatedInitializers {
                InstanceStorageTypes(type.Definition!!)
            } else {
                default(Dictionary[FieldSymbol, TypeSymbol]?)
            }
            let supplied = zeroValue
                .Initializers
                .Select((initializer BoundFieldInitializer) -> initializer.Field ?? initializer.Property?.BackingField)
                .OfType[FieldSymbol]()
                .Select((field FieldSymbol) -> zeroValue.StructType.GetDefinitionField(field) ?? field)
                .ToHashSet()
            for storage in InstanceStorageTypes(type) {
                let writtenField FieldSymbol? = type.GetDefinitionField(storage.Key)
                let declaredField = writtenField ?? storage.Key
                let resultOverwritten = supplied.Contains(declaredField)
                let constructorInitialized = validatedInitializers && this.TryVisitConstructorInitializer(
                    type,
                    storage.Key,
                    zeroValue,
                    resultOverwritten
                )
                if resultOverwritten || constructorInitialized {
                    continue
                }
                // Arrays have element obligations even when their storage itself
                // is not a required handle. Check every actual helper value.
                if type.ValueStructDefaultCtorIsZeroInitialization &&
                    MagicCollectionZeroValue.TrySynthesizeInTypeZeroField(
                    zeroValue.Syntax,
                    type,
                    storage.Key
                ) is {} helperValue {
                    this.VisitExpression(helperValue)
                    continue
                }
                if this.RequiredHandle(storage.Value) != nil {
                    // A validated ordinary constructor proves its definition's
                    // written fields, not unwritten properties or new T slots.
                    if writtenField != nil && declaredStorage != nil && declaredStorage.TryGetValue(
                        declaredField,
                        out var declaredType
                    ) &&
                        this.RequiredHandle(declaredType) != nil {
                        continue
                    }
                    if requireInitializedResult {
                        this.ReportRequired(
                            zeroValue,
                            storage.Value,
                            "zero initialization would synthesize a null non-null managed-reference field '${storage.Key.Name}'; explicitly construct the aggregate"
                        )
                    }
                } else if storage
                    .Key
                    .Accessibility != Accessibility.Public &&
                    MagicCollectionZeroValue.TrySynthesizeEmptyInstance(zeroValue.Syntax, storage.Value) != nil &&
                    zeroValue.Syntax is {} syntax {
                    // No in-type store exists, and an external private-field
                    // store is not a legal substitute for the missing zero path.
                    this.diagnostics.ReportMemberInaccessible(
                        syntax.Location,
                        storage.Key.Name,
                        type.Name,
                        storage.Key.Accessibility
                    )
                }
            }
            return
        }
        let initialized = type
            .InstanceFieldInitializers
            .Keys
            .Select((field FieldSymbol) -> field.Name)
            .Concat(type.PrimaryConstructorParameters.Select((parameter ParameterSymbol) -> parameter.Name))
            .ToHashSet()
        for field in fields {
            if initialized.Contains(field.Name) {
                continue
            }
            this.diagnostics.ReportManagedReference(
                Invariant.Required(
                    field.Declaration ?? type.Declaration,
                    "source fields have a declaration",
                    expression: "field.Declaration ?? type.Declaration"
                )
                    .Location,
                "field '${field.Name}' must be initialized by every compiler-owned constructor path"
            )
        }
    }

    private func CheckSuspendingLocation(
        receiver BoundExpression?,
        value BoundExpression,
        captureReferenceOwners bool = false
    ) {
        // Method receivers cannot yet use the property/borrow address reconstruction path.
        if receiver != nil && !Binder.IsReferenceTypeForConstraint(receiver.Type) && RefCapabilities.IsBorrowedLocation(
            receiver,
            this.managedLocations,
            captureReferenceOwners
        ) &&
            AsyncBoundTreeQueries
            .HasAwait(value) {
            this.Report(
                value,
                "a borrowed receiver cannot survive a later suspension; evaluate the suspending value before selecting the location"
            )
        }
    }

    private func IsManagedLocation(expression BoundExpression) bool -> RefCapabilities.IsBorrowedLocation(
        expression,
        this.managedLocations
    )

    private func CheckConstruction(
        type StructSymbol,
        node BoundExpression,
        initialized IEnumerable[FieldSymbol?],
        explicitConstructor bool
    ) {
        var type = type
        let supplied = initialized
            .OfType[FieldSymbol]()
            .Select((field FieldSymbol) -> type.GetDefinitionField(field) ?? field)
            .ToHashSet()
        let suppliedNames = supplied.Select((field FieldSymbol) -> field.Name).ToHashSet()
        let requireInitializedResult = !object.ReferenceEquals(node, this.overwrittenInitializerResult)
        type = cast[StructSymbol](this.InitializerType(type))
        let defaultedPrimaryFields = HashSet[FieldSymbol]()
        if node is BoundStructLiteralExpression literal &&
            !literal.CallsPrimaryConstructor &&
            type
            .HasDeclaredPrimaryConstructor {
            for argument in literal.GetPrimaryConstructorArguments() {
                if !argument.IsSupplied {
                    this.VisitExpression(argument.Value)
                    defaultedPrimaryFields.Add(type.GetDefinitionField(argument.Field) ?? argument.Field)
                }
            }
        }
        if node is BoundStructLiteralExpression{IsZeroInitialization: true} zeroValue {
            this.CheckImplicitConstructorPath(
                type,
                ImmutableArray[FieldSymbol].Empty,
                zeroValue,
                requireInitializedResult
            )
            return
        }
        let explicitPath = explicitConstructor ||
            (
            type.ExplicitConstructors.Any((c ConstructorSymbol) -> c.Parameters.IsEmpty) &&
                !(
                node is BoundStructLiteralExpression && node.StructType.NeedsSynthesizedValueStructDefaultCtor == true
            )
        )
        let callsPrimary = node is BoundStructLiteralExpression &&
            node.CallsPrimaryConstructor == true ||
            (
            node is BoundConstructorCallExpression{SelectedConstructor: nil} call &&
                type.HasDeclaredPrimaryConstructor &&
                call
                .Arguments
                .Length == type
                .PrimaryConstructorParameters
                .Length
        )
        let constructorStores = HashSet[FieldSymbol](defaultedPrimaryFields)
        let constructorStoreNames = defaultedPrimaryFields.Select((field FieldSymbol) -> field.Name).ToHashSet()
        if callsPrimary {
            for parameter in type.PrimaryConstructorParameters {
                let field FieldSymbol? = switch BoundStructLiteralExpression.GetPrimaryMember(type, parameter.Name) {
                    case primaryField is FieldSymbol: primaryField
                    case property is PropertySymbol: property.BackingField
                    default: default(FieldSymbol?)
                }
                if field != nil {
                    let stored = type.GetDefinitionField(field) ?? field
                    constructorStores.Add(stored)
                    constructorStoreNames.Add(stored.Name)
                }
            }
        }
        if explicitPath ||
            type.IsClass ||
            callsPrimary ||
            (type.NeedsSynthesizedValueStructDefaultCtor && !type.ValueStructDefaultCtorIsZeroInitialization) {
            for field in type.Fields {
                let declaredField FieldSymbol? = type.GetDefinitionField(field)
                let storage = declaredField ?? field
                if this.TryVisitConstructorInitializer(
                    type,
                    field,
                    node,
                    supplied.Contains(storage) || suppliedNames.Contains(storage.Name)
                ) {
                    let stored = Invariant.Required(
                        declaredField,
                        "a constructor initializer has definition-owned field storage",
                        expression: "declaredField"
                    )
                    constructorStores.Add(stored)
                    constructorStoreNames.Add(stored.Name)
                }
            }
        }
        if explicitPath {
            return
        }
        for storage in InstanceStorageTypes(type) {
            let declaredField = type.GetDefinitionField(storage.Key) ?? storage.Key
            if requireInitializedResult && this.RequiredHandle(storage.Value) != nil && !supplied.Contains(
                declaredField
            ) &&
                !suppliedNames.Contains(declaredField.Name) && !constructorStores.Contains(declaredField) &&
                !constructorStoreNames
                .Contains(declaredField.Name) {
                this.ReportRequired(
                    node,
                    storage.Value,
                    "construction must initialize non-null managed-reference field '${storage.Key.Name}'"
                )
            }
        }
    }

    private func RequiredHandle(type TypeSymbol) TypeSymbol? {
        if this.required.TryGetValue(type, out var found) {
            return found
        }
        this.required[type] = nil
        if ManagedReferenceTypes.TryGetElement(type, out _, out _) || NativeProtocolSafety.IsProtocol(type) {
            this.required[type] = type
            return type
        }
        var fields IEnumerable[TypeSymbol]
        if type is StructSymbol{IsClass: false} source {
            fields = InstanceStorageTypes(source).Values
        } else if type is TupleTypeSymbol tuple {
            fields = tuple.ElementTypes
        } else if type is ArrayTypeSymbol{Length: > 0} array {
            fields = []TypeSymbol{array.ElementType}
        } else if !(type is NullableTypeSymbol) &&
            !(type is TypeParameterSymbol) &&
            type.ClrType is {IsValueType: true, IsPrimitive: false, IsEnum: false, IsGenericParameter: false} clr {
            fields = clr.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Select(
                ClrNullability.GetFieldTypeSymbol
            )
        } else {
            return nil
        }
        for field in fields {
            if this.RequiredHandle(field) is {} handle {
                this.required[type] = handle
                return handle
            }
        }
        return nil
    }

    private func Report(node BoundNode, reason string, fallback BoundNode? = nil) {
        if (this.initializerAnchor ?? node.Syntax ?? fallback?.Syntax) is {} syntax {
            this.diagnostics.ReportManagedReference(syntax.Location, reason)
        }
    }

    private func ReportRequired(node BoundNode, type TypeSymbol, reason string) {
        let requiredType = this.RequiredHandle(type)
        if requiredType != nil && NativeProtocolSafety.IsProtocol(requiredType) &&
            (this.initializerAnchor ?? node.Syntax) is {} syntax {
            this.diagnostics.ReportNativeProtocol(
                syntax.Location,
                reason.Replace("managed-reference", "protocol").Replace("nullable handle", "nullable protocol value")
            )
        } else {
            this.Report(node, reason)
        }
    }

    private func InitializerType(type TypeSymbol) TypeSymbol -> this.initializerOwner?.SubstituteMemberType(type) ??
        type

    private func TryVisitConstructorInitializer(
        owner StructSymbol,
        field FieldSymbol,
        site BoundExpression,
        resultOverwritten bool = false
    ) bool {
        let writtenField FieldSymbol? = owner.GetDefinitionField(field)
        if writtenField == nil || !owner.Definition!!.InstanceFieldInitializers.TryGetValue(
            writtenField,
            out var initializer
        ) {
            return false
        }
        this.VisitConstructedInitializer(owner, site, initializer, resultOverwritten)
        return true
    }

    private func VisitConstructedInitializer(
        owner StructSymbol,
        site BoundExpression,
        initializer BoundExpression,
        resultOverwritten bool
    ) {
        let anchor = this.initializerAnchor ??
            (
            if owner.IsClass ||
                owner.IsData ||
                site is BoundStructLiteralExpression &&
                site.IsZeroInitialization == true {
                site.Syntax
            } else {
                default(SyntaxNode?)
            }
        )
        let completedKey = (
            owner.Definition!!,
            owner,
            initializer,
            anchor,
            resultOverwritten,
            this.analyzingStateMachine
        )
        if this.completedInitializers.Contains(completedKey) || this.activeInitializers.Contains((owner, initializer)) {
            return
        }
        // Exact-owner cycles terminate above; growing type arguments need a finite bound.
        if this.activeInitializers.Count >= MaxInitializerDepth {
            this.Report(
                site,
                "constructor initializer validation exceeds the supported recursion depth of $MaxInitializerDepth; simplify the recursive construction"
            )
            return
        }
        this.activeInitializers.Add((owner, initializer))
        let previousOwner = this.initializerOwner
        let previousAnchor = this.initializerAnchor
        let previousOverwrittenResult = this.overwrittenInitializerResult
        this.initializerOwner = owner
        this.initializerAnchor = anchor
        // A later store replaces this result, not the expressions executed to obtain it.
        this.overwrittenInitializerResult = if resultOverwritten {
            initializer
        } else {
            default(BoundExpression?)
        }
        try {
            this.InitializerVisitCount++
            this.VisitExpression(initializer)
            // Diagnostics already belong to this anchor; other sites must validate separately.
            this.completedInitializers.Add(completedKey)
        } finally {
            this.initializerOwner = previousOwner
            this.initializerAnchor = previousAnchor
            this.overwrittenInitializerResult = previousOverwrittenResult
            this.activeInitializers.Remove((owner, initializer))
        }
    }

    private func CheckScopedStore(value BoundExpression, sink BoundNode? = nil) {
        if ManagedReferenceOrigins.IsScopedHandle(value) {
            this.Report(
                value,
                "a scoped managed-reference value cannot be stored in heap-owned or unknown storage",
                sink
            )
        }
    }

    private class ConstructorAssignmentProjection : BoundTreeRewriter {
        private let type StructSymbol
        private let function FunctionSymbol
        private let syntax SyntaxNode?
        private let fields Dictionary[FieldSymbol, LocalVariableSymbol] = Dictionary[FieldSymbol, LocalVariableSymbol]()

        internal init(
            type StructSymbol,
            constructor ConstructorSymbol,
            fields ImmutableArray[FieldSymbol],
            analyzer ManagedReferenceSafetyAnalyzer
        ) {
            this.type = type
            this.function = constructor.Function
            this.syntax = constructor.Declaration
            for field in fields {
                this.fields.Add(
                    field,
                    LocalVariableSymbol(
                        field.Name,
                        false,
                        Invariant.Required(
                            analyzer.RequiredHandle(field.Type),
                            "the caller selected required managed-reference fields",
                            expression: "analyzer.RequiredHandle(field.Type)"
                        )
                    )
                )
            }
        }

        internal func Project(body BoundBlockStatement) BoundBlockStatement {
            let prefix = ImmutableArray.CreateBuilder[BoundStatement]()
            for pair in this.fields {
                let initializer = if this.type.InstanceFieldInitializers.TryGetValue(pair.Key, out var value) {
                    value
                } else {
                    cast[BoundExpression](BoundDefaultExpression(this.syntax, pair.Value.Type))
                }
                prefix.Add(BoundVariableDeclaration(this.syntax, pair.Value, initializer))
            }
            prefix.AddRange((cast[BoundBlockStatement](this.RewriteStatement(body))).Statements)
            prefix.AddRange(this.ReadFields())
            return BoundBlockStatement(body.Syntax, prefix.ToImmutable())
        }

        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            if this.fields.TryGetValue(node.Field, out var variable) &&
                (
                node.Receiver == this
                    .function
                    .ThisParameter ||
                    (
                    node.ReceiverExpression is BoundVariableExpression receiver &&
                        receiver.Variable == this
                        .function
                        .ThisParameter
                )
            ) {
                return BoundAssignmentExpression(node.Syntax, variable, this.RewriteExpression(node.Value))
            }
            return base.RewriteFieldAssignmentExpression(node)
        }

        protected override func RewriteReturnStatement(node BoundReturnStatement) BoundStatement -> BoundBlockStatement(
            node.Syntax,
            this.ReadFields().Add(node)
        )

        private func ReadFields() ImmutableArray[BoundStatement] -> this
            .fields
            .Values
            .Select(
            (variable LocalVariableSymbol) -> cast[BoundStatement](
                BoundExpressionStatement(this.syntax, BoundVariableExpression(this.syntax, variable))
            )
        )
            .ToImmutableArray()
    }

    private class StaticAssignmentProjection : BoundTreeRewriter {
        private let type StructSymbol
        private let syntax SyntaxNode?
        private let fields Dictionary[FieldSymbol, LocalVariableSymbol] = Dictionary[FieldSymbol, LocalVariableSymbol]()

        internal init(type StructSymbol, fields ImmutableArray[FieldSymbol], analyzer ManagedReferenceSafetyAnalyzer) {
            this.type = type
            this.syntax = type.Declaration
            for field in fields {
                this.fields.Add(
                    field,
                    LocalVariableSymbol(
                        field.Name,
                        false,
                        Invariant.Required(
                            analyzer.RequiredHandle(field.Type),
                            "the caller selected required managed-reference fields",
                            expression: "analyzer.RequiredHandle(field.Type)"
                        ),
                        field.Declaration
                    )
                )
            }
        }

        internal func Project(statements ImmutableArray[BoundStatement]) BoundBlockStatement {
            let projected = ImmutableArray.CreateBuilder[BoundStatement]()
            for pair in this.fields {
                let initializer = if this.type.StaticFieldInitializers.TryGetValue(pair.Key, out var value) {
                    value
                } else {
                    cast[BoundExpression](BoundDefaultExpression(pair.Key.Declaration ?? this.syntax, pair.Value.Type))
                }
                projected.Add(BoundVariableDeclaration(pair.Key.Declaration ?? this.syntax, pair.Value, initializer))
            }
            projected.AddRange(
                (
                    cast[BoundBlockStatement](this.RewriteStatement(BoundBlockStatement(this.syntax, statements)))
                ).Statements
            )
            projected.AddRange(this.ReadFields())
            return BoundBlockStatement(this.syntax, projected.ToImmutable())
        }

        protected override func RewriteAssignmentExpression(node BoundAssignmentExpression) BoundExpression {
            if node.Variable is ImplicitStaticFieldVariableSymbol staticField && this.fields.TryGetValue(
                staticField.Field,
                out var variable
            ) {
                return BoundAssignmentExpression(node.Syntax, variable, this.RewriteExpression(node.Expression))
            }
            return base.RewriteAssignmentExpression(node)
        }

        protected override func RewriteFieldAssignmentExpression(node BoundFieldAssignmentExpression) BoundExpression {
            if node.Receiver == nil && node.ReceiverExpression == nil && this.fields.TryGetValue(
                node.Field,
                out var variable
            ) {
                return BoundAssignmentExpression(node.Syntax, variable, this.RewriteExpression(node.Value))
            }
            return base.RewriteFieldAssignmentExpression(node)
        }

        protected override func RewritePropertyAssignmentExpression(
            node BoundPropertyAssignmentExpression
        ) BoundExpression {
            if node.Receiver == nil && node.Property.BackingField is {} field && this.fields.TryGetValue(
                field,
                out var variable
            ) {
                return BoundAssignmentExpression(node.Syntax, variable, this.RewriteExpression(node.Value))
            }
            return base.RewritePropertyAssignmentExpression(node)
        }

        private func ReadFields() ImmutableArray[BoundStatement] -> this
            .fields
            .Values
            .Select(
            (variable LocalVariableSymbol) -> cast[BoundStatement](
                BoundExpressionStatement(
                    variable.DeclaringSyntax ?? this.syntax,
                    BoundVariableExpression(variable.DeclaringSyntax ?? this.syntax, variable)
                )
            )
        )
            .ToImmutableArray()
    }

    shared {
        private const MaxInitializerDepth int32 = 64

        func Analyze(
            functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder,
            types ImmutableArray[StructSymbol],
            interfaces ImmutableArray[InterfaceSymbol],
            diagnostics DiagnosticBag
        ) {
            NativeProtocolSafety.BeginMemo()
            try {
                AnalyzeCore(functions, types, interfaces, diagnostics)
            } finally {
                NativeProtocolSafety.EndMemo()
            }
        }

        private func AnalyzeCore(
            functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder,
            types ImmutableArray[StructSymbol],
            interfaces ImmutableArray[InterfaceSymbol],
            diagnostics DiagnosticBag
        ) {
            let analyzer = ManagedReferenceSafetyAnalyzer(diagnostics)
            for (function, body) in functions {
                analyzer.AnalyzeFunction(function, body)
            }
            for type in types {
                ValidateDeclaredSignatures(
                    type.Methods.Concat(type.StaticMethods),
                    type.Properties.Concat(type.StaticProperties),
                    type.Events.Concat(type.StaticEvents),
                    functions,
                    diagnostics
                )
                if type.BaseType is {} importedBase &&
                    importedBase.ClrType != nil &&
                    NativeProtocolSafety
                    .ContainsSavedProtocol(importedBase) {
                    diagnostics.ReportNativeProtocol(
                        type.Declaration?.Location ?? default(TextLocation),
                        "native-bearing imported base initialization requires a separately admitted metadata-aware constructor contract"
                    )
                }
                for field in type.Fields.Concat(type.StaticFields) {
                    if NativeProtocolMetadata.IsPublic(type) && field.Accessibility == Accessibility.Public {
                        NativeProtocolSafety.ValidatePublicContractType(
                            field.Type,
                            field.Declaration?.Location ?? type.Declaration?.Location ?? default(TextLocation),
                            diagnostics
                        )
                    }
                    NativeProtocolSafety.ValidateStorageType(
                        field.Type,
                        field.Declaration?.Location ?? type.Declaration?.Location ?? default(TextLocation),
                        diagnostics
                    )
                }
                for property in type.Properties.Concat(type.StaticProperties) {
                    let location = property.Declaration?.Location ?? type.Declaration?.Location ?? default(TextLocation)
                    if NativeProtocolMetadata.IsPublic(type) && property.Accessibility == Accessibility.Public {
                        NativeProtocolSafety.ValidatePublicContractType(property.Type, location, diagnostics)
                    }
                    NativeProtocolSafety.ValidateStorageType(property.Type, location, diagnostics)
                    if property.IsAutoProperty && NativeProtocolSafety.ContainsSavedProtocol(property.Type) {
                        diagnostics.ReportNativeProtocol(
                            location,
                            "native-bearing auto-property initialization/accessor boundaries are not admitted; use checked ordinary storage and explicit methods"
                        )
                    }
                }
                analyzer.CheckPrimaryConstructorParameters(type)
                analyzer.CheckBaseInitializer(type.BaseConstructorInitializer)
                for constructor in type.ExplicitConstructors {
                    analyzer.CheckBaseInitializer(constructor.BaseInitializer)
                }
                for initializer in type.InstanceFieldInitializers.Values.Concat(type.StaticFieldInitializers.Values) {
                    analyzer.CheckScopedStore(initializer)
                    analyzer.VisitExpression(initializer)
                }
                analyzer.Visit(BoundBlockStatement(type.Declaration, type.StaticInitializerStatements))
                let staticFields = type
                    .StaticFields
                    .Concat(
                    type
                        .StaticProperties
                        .Where((p PropertySymbol) -> p.IsAutoProperty)
                        .Select((p PropertySymbol) -> p.BackingField)
                        .OfType[FieldSymbol]()
                )
                    .Where((f FieldSymbol) -> analyzer.RequiredHandle(f.Type) != nil)
                    .ToImmutableArray()
                if !staticFields.IsDefaultOrEmpty {
                    analyzer.CheckRequiredStaticPaths(type, staticFields)
                }
                let instanceFields = type
                    .Fields
                    .Where((f FieldSymbol) -> analyzer.RequiredHandle(f.Type) != nil)
                    .ToImmutableArray()
                if !instanceFields.IsDefaultOrEmpty {
                    analyzer.CheckRequiredConstructorPaths(type, instanceFields, functions)
                }
            }
            for type in interfaces {
                ValidateDeclaredSignatures(
                    type
                        .Methods
                        .Concat(type.StaticMethods)
                        .Concat(type.PrivateMethods)
                        .Concat(type.StaticPrivateMethods),
                    type.Properties,
                    type.Events,
                    functions,
                    diagnostics
                )
                for field in type.StaticFields {
                    let location = field.Declaration?.Location ?? type.Declaration.Location
                    NativeProtocolSafety.ValidateStorageType(field.Type, location, diagnostics)
                    if NativeProtocolMetadata.IsPublic(type) && field.Accessibility == Accessibility.Public {
                        NativeProtocolSafety.ValidatePublicContractType(field.Type, location, diagnostics)
                    }
                    if type.StaticFieldInitializers.TryGetValue(field, out var initializer) {
                        analyzer.CheckScopedStore(initializer)
                        analyzer.VisitExpression(initializer)
                    } else if analyzer.RequiredHandle(field.Type) != nil {
                        let syntax = Invariant.Required(
                            field.Declaration ?? type.Declaration,
                            "source interface fields have a declaration",
                            expression: "field.Declaration ?? type.Declaration"
                        )
                        if NativeProtocolSafety.IsProtocol(analyzer.RequiredHandle(field.Type)!!) {
                            diagnostics.ReportNativeProtocol(
                                syntax.Location,
                                "interface field '${field.Name}' requires a present protocol initializer"
                            )
                        } else {
                            diagnostics.ReportManagedReference(
                                syntax.Location,
                                "interface field '${field.Name}' requires a non-null managed-reference initializer"
                            )
                        }
                    }
                }
            }
        }

        private func ValidateDeclaredSignatures(
            methods IEnumerable[FunctionSymbol],
            properties IEnumerable[PropertySymbol],
            events IEnumerable[EventSymbol],
            functions ImmutableDictionary[FunctionSymbol, BoundBlockStatement].Builder,
            diagnostics DiagnosticBag
        ) {
            let signatures = methods.Concat(
                properties.SelectMany(
                    (property PropertySymbol) -> []FunctionSymbol? {property.GetterSymbol, property.SetterSymbol}
                )
                    .OfType[FunctionSymbol]()
            )
                .Concat(
                events.SelectMany(
                    (eventSymbol EventSymbol) -> []FunctionSymbol? {
                        eventSymbol.AddMethodSymbol,
                        eventSymbol.RemoveMethodSymbol,
                        eventSymbol.RaiseMethodSymbol
                    }
                )
                    .OfType[FunctionSymbol]()
            )
            for function in signatures.Distinct() {
                if !functions.ContainsKey(function) {
                    NativeProtocolSafety.ValidateSignature(function, diagnostics)
                }
            }
        }

        private func IsManagedReferenceEquality(binary BoundClrBinaryOperatorExpression) bool -> (
            binary.OperatorKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken
        ) &&
            binary.Method is {Name: "op_Equality" or "op_Inequality", DeclaringType: {} declaringType} &&
            ManagedReferenceTypes.IsDefinition(declaringType, out _)

        private func VariableReceiver(variable VariableSymbol?) BoundExpression? -> if variable == nil {
            default(BoundVariableExpression?)
        } else {
            BoundVariableExpression(variable.DeclaringSyntax, variable)
        }

        private func InstanceStorageTypes(type StructSymbol) Dictionary[FieldSymbol, TypeSymbol] {
            let storage = type.Fields.ToDictionary((field FieldSymbol) -> field, (field FieldSymbol) -> field.Type)
            for property in type.Properties {
                if property.BackingField is {} backingField {
                    storage[backingField] = property.Type
                }
            }
            return storage
        }
    }
}
