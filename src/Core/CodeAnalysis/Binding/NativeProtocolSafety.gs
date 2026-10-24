// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal shared class NativeProtocolSafety {
    // The whole-program safety pass asks the same two questions about the same few
    // types for every bound expression (issue #5197). Each answer is a finite walk
    // that depends only on declarations, which are complete by then, so the pass
    // keeps its answers for the span of one run. Outside a run (binding, emit) the
    // memo is absent and every query walks, as before. Thread-static, so concurrent
    // compilations never share it.
    @ThreadStatic
    private var memoSaved Dictionary[TypeSymbol, bool]?

    @ThreadStatic
    private var memoAny Dictionary[TypeSymbol, bool]?

    @ThreadStatic
    private var memoProtocol Dictionary[TypeSymbol, bool]?

    // Every entry of one top-level walk (a type may appear more than once), so a
    // walk that finds nothing can record each of them as protocol-free (issue #5201).
    @ThreadStatic
    private var walkVisited List[TypeSymbol]?

    @ThreadStatic
    private var memoDepth int32

    // Hits are tallied in plain thread-static fields and published once when the
    // outermost pass ends: a named counter costs a dictionary update, which is
    // too much for a path that runs once per bound expression.
    @ThreadStatic
    private var memoHits int64

    @ThreadStatic
    private var memoWalks int64

    @ThreadStatic
    private var memoPruned int64

    @ThreadStatic
    private var memoEntered int64

    // Re-entrant: only the outermost Begin installs the memo and only the
    // matching outermost End drops it, so a nested pass cannot clear the outer
    // pass's answers. Callers pair them in try/finally.
    internal func BeginMemo() {
        if memoDepth == 0 {
            memoSaved = Dictionary[TypeSymbol, bool]()
            memoAny = Dictionary[TypeSymbol, bool]()
            memoProtocol = Dictionary[TypeSymbol, bool]()
            memoHits = 0
            memoWalks = 0
            memoPruned = 0
            memoEntered = 0
        }
        memoDepth++
    }

    internal func EndMemo() {
        if memoDepth > 0 {
            memoDepth--
            if memoDepth == 0 {
                memoSaved = nil
                memoAny = nil
                memoProtocol = nil
                walkVisited = nil
                CompilationMeasurements.Count("nativeprotocol.memo-hits", memoHits)
                CompilationMeasurements.Count("nativeprotocol.memo-walks", memoWalks)
                CompilationMeasurements.Count("nativeprotocol.memo-pruned", memoPruned)
                CompilationMeasurements.Count("nativeprotocol.walk-entered", memoEntered)
                memoHits = 0
                memoWalks = 0
                memoPruned = 0
                memoEntered = 0
            }
        }
    }

    // NativeProtocolMetadata.IsProtocol reads custom-attribute data for an imported
    // interface on every call. It depends only on the type, so the run keeps the
    // answer (issue #5201). Absent a run it simply asks.
    internal func IsProtocol(type TypeSymbol) bool {
        let memo = memoProtocol
        if memo == nil {
            return NativeProtocolMetadata.IsProtocol(type)
        }
        if memo.TryGetValue(type, out var known) {
            return known
        }
        let found = NativeProtocolMetadata.IsProtocol(type)
        memo[type] = found
        return found
    }

    internal func ContainsSavedProtocol(type TypeSymbol) bool {
        let memo = memoSaved
        if memo == nil {
            return ContainsDependency(type, true, HashSet[TypeSymbol](), HashSet[System.Type]())
        }
        return QueryMemoized(type, true, memo)
    }

    internal func ContainsProtocol(type TypeSymbol) bool {
        let memo = memoAny
        if memo == nil {
            return ContainsDependency(type, false, HashSet[TypeSymbol](), HashSet[System.Type]())
        }
        return QueryMemoized(type, false, memo)
    }

    private func QueryMemoized(type TypeSymbol, includeStorage bool, memo Dictionary[TypeSymbol, bool]) bool {
        if memo.TryGetValue(type, out var known) {
            memoHits++
            return known
        }
        memoWalks++
        let outer = walkVisited
        let visited = List[TypeSymbol]()
        walkVisited = visited
        var found = false
        try {
            found = ContainsDependency(type, includeStorage, HashSet[TypeSymbol](), HashSet[System.Type]())
        } finally {
            walkVisited = outer
        }
        memoEntered += visited.Count
        // Only a negative top-level answer is recorded for the types the walk
        // entered. A walk that finds nothing has entered every type reachable
        // from its root (a cutoff only skips a type that is already entered),
        // so each entered type's own reachable set lies inside a protocol-free
        // set and is protocol-free alone. A later walk can then stop at it
        // instead of re-walking its whole graph (a class's fields reach most of
        // the compiler's types). Stopping early cannot change an answer: if
        // Box[A] is recorded, Box's definition is protocol-free, so a later walk
        // of Box[B] can only find a protocol through B, which the
        // type-argument check examines before the definition cutoff anyway. A
        // positive walk records only its root: its inner results were reached
        // under seen/importedDelegates cutoffs and prove nothing about the types
        // entered on the way. The memo is keyed per includeStorage, as the
        // walk's edges differ between the two queries.
        if !found {
            for entered in visited {
                memo[entered] = false
            }
        }
        memo[type] = found
        return found
    }

    internal func RequiresFeatureMarker(function FunctionSymbol) bool ->
    RequiresFeatureMarker(function.Type, function.Parameters, function.ReceiverType)

    internal func RequiresFeatureMarker(
        returnType TypeSymbol,
        parameters ImmutableArray[ParameterSymbol],
        receiverType TypeSymbol? = nil
    ) bool ->
    ContainsSavedProtocol(returnType) || parameters.Any(
        (parameter ParameterSymbol) -> ContainsSavedProtocol(parameter.Type)
    ) ||
        receiverType is {} receiver &&
        ContainsSavedProtocol(receiver)

    private func ContainsDependency(
        type TypeSymbol,
        includeStorage bool,
        seen HashSet[TypeSymbol],
        importedDelegates HashSet[System.Type]
    ) bool {
        let entered = walkVisited
        if entered != nil {
            let memo = if includeStorage {
                memoSaved
            } else {
                memoAny
            }
            if memo != nil && memo.TryGetValue(type, out var settled) {
                memoPruned++
                return settled
            }
            entered.Add(type)
        }
        if NativeProtocolOperations.GetProtocol(type) != nil {
            return true
        }
        if type is NullableTypeSymbol nullable {
            return ContainsDependency(nullable.UnderlyingType, includeStorage, seen, importedDelegates)
        }
        if type is PlatformTypeSymbol platform {
            return ContainsDependency(platform.UnderlyingType, includeStorage, seen, importedDelegates)
        }
        if type is ByRefTypeSymbol byRef {
            return ContainsDependency(byRef.PointeeType, includeStorage, seen, importedDelegates)
        }
        if type is StructSymbol || type is DelegateTypeSymbol {
            // Arguments precede the finite definition cut; signatures/storage follow it.
            if TypeArguments(type).Any(
                (argument TypeSymbol) -> ContainsDependency(argument, includeStorage, seen, importedDelegates)
            ) {
                return true
            }
        } else if !seen.Add(
            if type is NullabilityAnnotatedTypeSymbol annotated {
                annotated.BaseType
            } else {
                type
            }
        ) {
            return false
        }
        if type is StructSymbol aggregate {
            if !seen.Add(aggregate.Definition) {
                return false
            }
            return includeStorage &&
                (
                aggregate.BaseType is {} parent &&
                    ContainsDependency(parent, true, seen, importedDelegates) ||
                    aggregate
                    .PrimaryConstructorParameters
                    .Any(
                    (parameter ParameterSymbol) -> ContainsDependency(parameter.Type, true, seen, importedDelegates)
                ) ||
                    aggregate
                    .Fields
                    .Concat(aggregate.StaticFields)
                    .Concat(
                    aggregate
                        .Properties
                        .Concat(aggregate.StaticProperties)
                        .Select((property PropertySymbol) -> property.BackingField)
                        .OfType[FieldSymbol]()
                )
                    .Any((field FieldSymbol) -> ContainsDependency(field.Type, true, seen, importedDelegates)) ||
                    aggregate.ClrType is {} importedAggregate &&
                    NativeProtocolMetadata.HasFeatureMarker(importedAggregate)
            )
        }
        if type is InterfaceSymbol contract && includeStorage && contract.StaticFields.Any(
            (field FieldSymbol) -> ContainsDependency(field.Type, true, seen, importedDelegates)
        ) {
            return true
        }
        if type is DelegateTypeSymbol named {
            if !seen.Add(named.Definition ?? named) {
                return false
            }
            return ContainsDependency(named.ReturnType, includeStorage, seen, importedDelegates) ||
                named
                .Parameters
                .Any(
                (parameter ParameterSymbol) -> ContainsDependency(
                    parameter.Type,
                    includeStorage,
                    seen,
                    importedDelegates
                )
            )
        }
        if type.GetElementPositions().Any(
            (position TypeSymbol) -> ContainsDependency(position, includeStorage, seen, importedDelegates)
        ) {
            return true
        }
        if type.ClrType is {} imported && ClrTypeUtilities.IsDelegateType(imported) && importedDelegates.Add(
            if imported.IsGenericType {
                imported.GetGenericTypeDefinition()
            } else {
                imported
            }
        ) &&
            MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(type, out var signature) &&
            signature is {} targetSignature {
            if ContainsDependency(targetSignature, includeStorage, seen, importedDelegates) {
                return true
            }
        }
        return includeStorage && type.ClrType is {} marked && NativeProtocolMetadata.HasFeatureMarker(marked)
    }

    private func TypeArguments(type TypeSymbol) ImmutableArray[TypeSymbol] -> switch type {
        case aggregate is StructSymbol: aggregate.TypeArguments.AddRange(aggregate.EnclosingTypeArguments)
        case contract is InterfaceSymbol: contract.TypeArguments
        case named is DelegateTypeSymbol: named.TypeArguments
        default: type.ConstructedTypeArguments
    }

    internal func ValidateSignature(function FunctionSymbol, diagnostics DiagnosticBag) {
        let location = function.Declaration?.Location ?? switch function.AssociatedSymbol {
            case property is PropertySymbol: property.Declaration?.Location ?? default(TextLocation)
            case eventSymbol is EventSymbol: eventSymbol.Declaration?.Location ?? default(TextLocation)
            default: default(TextLocation)
        }
        let receiver = function.ReceiverType
        let owner = function.StaticOwnerType
        if function.Accessibility == Accessibility.Public &&
            (receiver == nil || NativeProtocolMetadata.IsPublic(receiver)) &&
            (owner == nil || NativeProtocolMetadata.IsPublic(owner)) {
            ValidatePublicContractType(function.Type, location, diagnostics)
            for parameter in function.Parameters {
                ValidatePublicContractType(parameter.Type, location, diagnostics)
            }
        }
        if function.Parameters.Any(
            (parameter ParameterSymbol) ->
            parameter.RefKind != RefKind.None && ContainsProtocol(parameter.Type)
        ) ||
            function.ReturnRefKind != RefKind.None &&
            ContainsProtocol(function.Type) {
            diagnostics.ReportNativeProtocol(
                location,
                "by-reference native protocol signatures require an admitted boundary contract"
            )
        }
        if (function.IsAsyncOrSuspending || function.IsGeneric) &&
            (
            ContainsProtocol(function.Type) || function.Parameters.Any(
                (parameter ParameterSymbol) -> ContainsProtocol(parameter.Type)
            )
        ) {
            diagnostics.ReportNativeProtocol(
                location,
                "generic or suspending native protocol signatures are not supported in this synchronous core"
            )
        }
        ValidateStorageType(function.Type, location, diagnostics)
        for parameter in function.Parameters {
            ValidateStorageType(parameter.Type, location, diagnostics)
        }
    }

    internal func ValidatePublicContractType(
        type TypeSymbol,
        location TextLocation,
        diagnostics DiagnosticBag,
        visited HashSet[TypeSymbol]? = nil
    ) {
        let seen = visited ?? HashSet[TypeSymbol]()
        if type is DelegateTypeSymbol delegateType {
            for argument in delegateType.TypeArguments {
                ValidatePublicContractType(argument, location, diagnostics, seen)
            }
        }
        if !seen.Add(
            if type is DelegateTypeSymbol namedType {
                namedType.Definition ?? namedType
            } else {
                type
            }
        ) {
            return
        }
        if NativeProtocolOperations.GetProtocol(type) is {} protocol && !NativeProtocolMetadata.IsPublic(protocol) {
            diagnostics.ReportNativeProtocol(location, "public native signatures require accessible contract types")
        }
        if type is DelegateTypeSymbol named {
            ValidatePublicContractType(named.ReturnType, location, diagnostics, seen)
            for parameter in named.Parameters {
                ValidatePublicContractType(parameter.Type, location, diagnostics, seen)
            }
        }
        for position in type.GetElementPositions() {
            ValidatePublicContractType(position, location, diagnostics, seen)
        }
    }

    internal func ValidateStorageType(
        type TypeSymbol,
        location TextLocation,
        diagnostics DiagnosticBag,
        visited HashSet[TypeSymbol]? = nil
    ) {
        // The overwhelmingly common answer is "no protocol anywhere in this type";
        // settle it before allocating the visited set (issue #5201). Either test
        // failing returns, so the order does not change the result.
        if visited == nil && !ContainsSavedProtocol(type) {
            return
        }
        let seen = visited ?? HashSet[TypeSymbol]()
        if !seen.Add(type) || !ContainsSavedProtocol(type) {
            return
        }
        if type is PlatformTypeSymbol && NativeProtocolOperations.GetProtocol(type) != nil {
            diagnostics.ReportNativeProtocol(
                location,
                "native protocol boundaries require explicit P/P? presence, not an oblivious platform contract"
            )
        }
        if NativeProtocolOperations.GetProtocol(type)
            ?.ClrType is {} imported &&
            !NativeProtocolMetadata
            .Read(imported.Assembly)
            .Protocols
            .Any((candidate System.Type) -> ClrTypeUtilities.AreSame(candidate, imported)) {
            diagnostics.ReportNativeProtocol(
                location,
                "missing or invalid imported native protocol declaration evidence"
            )
        }
        let shape = StorageShape(type)
        let tuple = shape is TupleTypeSymbol ||
            shape.ClrType is {IsGenericType: true} generic &&
            generic
            .GetGenericTypeDefinition().FullName is {} name && name.StartsWith(
            "System.ValueTuple`",
            System.StringComparison.Ordinal
        )
        if (
            shape is FunctionTypeSymbol ||
                shape is DelegateTypeSymbol ||
                shape.ClrType is {} clr &&
                ClrTypeUtilities.IsDelegateType(clr) ||
                shape is MapTypeSymbol ||
                shape is ChannelTypeSymbol ||
                shape is SequenceTypeSymbol ||
                shape is AsyncSequenceTypeSymbol ||
                !tuple &&
                !TypeArguments(shape).IsDefaultOrEmpty
        ) {
            diagnostics.ReportNativeProtocol(
                location,
                "native protocol delegate/generic container contracts are not admitted by this core"
            )
            return
        }
        for position in type.GetElementPositions() {
            ValidateStorageType(position, location, diagnostics, seen)
        }
    }

    private func StorageShape(type TypeSymbol) TypeSymbol -> switch type {
        case nullable is NullableTypeSymbol: StorageShape(nullable.UnderlyingType)
        case platform is PlatformTypeSymbol: StorageShape(platform.UnderlyingType)
        case annotated is NullabilityAnnotatedTypeSymbol: StorageShape(annotated.BaseType)
        default: type
    }

    internal func ValidateStorageErasure(
        source TypeSymbol,
        target TypeSymbol,
        location TextLocation,
        diagnostics DiagnosticBag
    ) {
        if ContainsSavedProtocol(source) && !ContainsSavedProtocol(target) {
            diagnostics.ReportNativeProtocol(
                location,
                "native protocol values cannot escape through object, nominal or generic conversions"
            )
        }
    }

    internal func ValidateProtocolSlotType(type TypeSymbol, location TextLocation, diagnostics DiagnosticBag) {
        if StorageShape(type) is ArrayTypeSymbol {
            diagnostics.ReportNativeProtocol(
                location,
                "fixed-array native protocol slots require a separately admitted reference contract"
            )
        }
        for position in type.GetElementPositions() {
            ValidateProtocolSlotType(position, location, diagnostics)
        }
    }

    internal func ValidateThrow(value BoundExpression, location TextLocation, diagnostics DiagnosticBag) {
        if ContainsSavedProtocol(value.Type) {
            diagnostics.ReportNativeProtocol(
                location,
                "native-bearing throw transport requires a separately admitted exception contract"
            )
        }
    }

    internal func ValidateExpression(node BoundExpression, diagnostics DiagnosticBag, anchor SyntaxNode?) {
        let location = (anchor ?? node.Syntax)?.Location ?? default(TextLocation)
        ValidateStorageType(node.Type, location, diagnostics)
        switch node {
            case throwing is BoundThrowExpression {
                ValidateThrow(throwing.Expression, location, diagnostics)
            }
            case conversion is BoundClrConversionCallExpression when conversion.Method is {} method {
                ValidateForeignCall(
                    method,
                    ContainsSavedProtocol(conversion.Source.Type) || ContainsSavedProtocol(conversion.Type),
                    location,
                    diagnostics
                )
            }
            case unary is BoundClrUnaryOperatorExpression {
                ValidateForeignCall(
                    unary.Method,
                    ContainsSavedProtocol(unary.Operand.Type) || ContainsSavedProtocol(unary.Type),
                    location,
                    diagnostics
                )
            }
            case literal is BoundFunctionLiteralExpression when literal.CapturedVariables.Any(
                (variable VariableSymbol) -> ContainsSavedProtocol(variable.Type)
            ) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native-bearing function capture requires a separately admitted delegate contract"
                )
            }
            case interpolation is BoundInterpolatedStringExpression when interpolation.Parts.Any(
                (part BoundInterpolatedStringPart) -> part.Value != nil && ContainsSavedProtocol(part.Value.Type)
            ) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol formatting requires an explicit admitted slot; object/generic formatting escapes are blocked"
                )
            }
            case binary is BoundBinaryExpression when
            (binary.Op.SyntaxKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken) &&
                (ContainsSavedProtocol(binary.Left.Type) || ContainsSavedProtocol(binary.Right.Type)) &&
                !IsNil(binary.Left) &&
                !IsNil(binary.Right) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol equality/hash is not admitted; only outer presence checks are supported"
                )
            }
            case binary is BoundClrBinaryOperatorExpression {
                let hasNative = ContainsSavedProtocol(binary.Left.Type) ||
                    ContainsSavedProtocol(binary.Right.Type) ||
                    ContainsSavedProtocol(binary.Type)
                if (binary.OperatorKind is SyntaxKind.EqualsEqualsToken or SyntaxKind.BangEqualsToken) &&
                    hasNative &&
                    !IsNil(binary.Left) &&
                    !IsNil(binary.Right) {
                    diagnostics.ReportNativeProtocol(
                        location,
                        "native protocol equality/hash is not admitted; only outer presence checks are supported"
                    )
                }
                if binary.Method is {} method {
                    ValidateForeignCall(method, hasNative, location, diagnostics)
                }
            }
            case conversion is BoundConversionExpression {
                ValidateStorageErasure(conversion.Expression.Type, conversion.Type, location, diagnostics)
            }
            case safeCast is BoundAsExpression {
                ValidateStorageErasure(safeCast.Expression.Type, safeCast.Type, location, diagnostics)
            }
            case call is BoundImportedInstanceCallExpression {
                if ContainsSavedProtocol(call.Receiver.Type) && IsEqualityMember(call.Method.Name) {
                    diagnostics.ReportNativeProtocol(location, "native-bearing aggregate equality/hash is not admitted")
                }
                if NativeProtocolOperations.GetProtocol(call.Receiver.Type) is {} protocol {
                    if call.Method.DeclaringType != protocol.ClrType {
                        diagnostics.ReportNativeProtocol(
                            location,
                            "only declared native protocol slots may be called; object/equality/hash escapes are unsupported"
                        )
                    }
                } else {
                    ValidateForeignCall(
                        call.Method,
                        ContainsSavedProtocol(call.Receiver.Type) ||
                            ContainsSavedProtocol(call.Type) ||
                            call
                            .Arguments
                            .Any((argument BoundExpression) -> ContainsSavedProtocol(argument.Type)),
                        location,
                        diagnostics
                    )
                }
                if call
                    .Method
                    .IsGenericMethod &&
                    !call
                    .TypeArgumentSymbols
                    .IsDefaultOrEmpty &&
                    call
                    .TypeArgumentSymbols
                    .Any((argument TypeSymbol?) -> argument != nil && ContainsSavedProtocol(argument)) {
                    diagnostics.ReportNativeProtocol(
                        location,
                        "native protocol generic invocation contracts are not admitted"
                    )
                }
            }
            case group is BoundMethodGroupExpression when group.Receiver != nil && NativeProtocolOperations.GetProtocol(
                group.Receiver.Type
            ) != nil {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol method-group export requires a separately admitted delegate contract"
                )
            }
            case group is BoundClrMethodGroupExpression when group.Receiver != nil &&
                NativeProtocolOperations.GetProtocol(group.Receiver.Type) != nil {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol method-group export requires a separately admitted delegate contract"
                )
            }
            case call is BoundImportedCallExpression {
                if IsEqualityMember(call.Function.Method.Name) && call.Arguments.Any(
                    (argument BoundExpression) -> ContainsSavedProtocol(argument.Type)
                ) {
                    diagnostics.ReportNativeProtocol(location, "native-bearing aggregate equality/hash is not admitted")
                }
                ValidateForeignCall(
                    call.Function.Method,
                    ContainsSavedProtocol(call.Type) || call.Arguments.Any(
                        (argument BoundExpression) -> ContainsSavedProtocol(argument.Type)
                    ) ||
                        !call
                        .TypeArgumentSymbols
                        .IsDefaultOrEmpty &&
                        call
                        .TypeArgumentSymbols
                        .Any((argument TypeSymbol?) -> argument != nil && ContainsSavedProtocol(argument)),
                    location,
                    diagnostics
                )
            }
            case call is BoundClrConstructorCallExpression {
                ValidateForeignCall(
                    call.Constructor,
                    ContainsSavedProtocol(call.Type) || call.Arguments.Any(
                        (argument BoundExpression) -> ContainsSavedProtocol(argument.Type)
                    ),
                    location,
                    diagnostics
                )
            }
            case access is BoundClrPropertyAccessExpression when access.Member is PropertyInfo property &&
                property.GetMethod is {} getter {
                ValidateForeignCall(
                    getter,
                    ContainsSavedProtocol(access.Type) ||
                        access.Receiver != nil &&
                        ContainsSavedProtocol(access.Receiver.Type),
                    location,
                    diagnostics
                )
            }
            case assignment is BoundClrPropertyAssignmentExpression when assignment.Member is PropertyInfo property &&
                property.SetMethod is {} setter {
                ValidateForeignCall(
                    setter,
                    ContainsSavedProtocol(assignment.Type) ||
                        ContainsSavedProtocol(assignment.Value.Type) ||
                        assignment.Receiver != nil &&
                        ContainsSavedProtocol(assignment.Receiver.Type),
                    location,
                    diagnostics
                )
            }
            case access is BoundClrPropertyAccessExpression when access.Member is FieldInfo field {
                ValidateForeignStorage(
                    field,
                    ContainsSavedProtocol(access.Type) ||
                        access.Receiver != nil &&
                        ContainsSavedProtocol(access.Receiver.Type),
                    location,
                    diagnostics
                )
            }
            case assignment is BoundClrPropertyAssignmentExpression when assignment.Member is FieldInfo field {
                ValidateForeignStorage(
                    field,
                    ContainsSavedProtocol(assignment.Type) ||
                        ContainsSavedProtocol(assignment.Value.Type) ||
                        assignment.Receiver != nil &&
                        ContainsSavedProtocol(assignment.Receiver.Type),
                    location,
                    diagnostics
                )
            }
            case access is BoundClrIndexExpression when access.Indexer.GetMethod is {} getter {
                ValidateForeignCall(
                    getter,
                    ContainsSavedProtocol(access.Type) ||
                        ContainsSavedProtocol(access.Target.Type) ||
                        access
                        .Arguments
                        .Any((argument BoundExpression) -> ContainsSavedProtocol(argument.Type)),
                    location,
                    diagnostics
                )
            }
            case assignment is BoundClrIndexAssignmentExpression when assignment.Indexer.SetMethod is {} setter {
                ValidateForeignCall(
                    setter,
                    ContainsSavedProtocol(assignment.Type) ||
                        ContainsSavedProtocol(assignment.Value.Type) ||
                        assignment.Target != nil &&
                        ContainsSavedProtocol(assignment.Target.Type) ||
                        assignment.TargetExpression != nil &&
                        ContainsSavedProtocol(assignment.TargetExpression.Type) ||
                        assignment
                        .Arguments
                        .Any((argument BoundExpression) -> ContainsSavedProtocol(argument.Type)),
                    location,
                    diagnostics
                )
            }
            case call is BoundCallExpression when IsEqualityMember(call.Function.Name) && call.Arguments.Any(
                (argument BoundExpression) -> ContainsSavedProtocol(argument.Type)
            ) {
                diagnostics.ReportNativeProtocol(location, "native-bearing aggregate equality/hash is not admitted")
            }
            case call is BoundUserInstanceCallExpression when IsEqualityMember(call.Method.Name) &&
                ContainsSavedProtocol(call.Receiver.Type) {
                diagnostics.ReportNativeProtocol(location, "native-bearing aggregate equality/hash is not admitted")
            }
            case call is BoundCallExpression when call
                .Function
                .IsGeneric &&
                (
                call.Arguments.Any((argument BoundExpression) -> ContainsSavedProtocol(argument.Type)) ||
                    !call
                    .MethodTypeArguments
                    .IsDefaultOrEmpty &&
                    call
                    .MethodTypeArguments
                    .Any((argument TypeSymbol) -> ContainsSavedProtocol(argument))
            ) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol generic invocation contracts are not admitted"
                )
            }
            case call is BoundUserInstanceCallExpression when call
                .Method
                .IsGeneric &&
                (
                call.Arguments.Any((argument BoundExpression) -> ContainsSavedProtocol(argument.Type)) ||
                    !call
                    .MethodTypeArguments
                    .IsDefaultOrEmpty &&
                    call
                    .MethodTypeArguments
                    .Any((argument TypeSymbol) -> ContainsSavedProtocol(argument))
            ) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol generic invocation contracts are not admitted"
                )
            }
        }
    }

    internal func ValidateForeignCall(
        method MethodBase,
        hasNativeArguments bool,
        location TextLocation,
        diagnostics DiagnosticBag
    ) {
        if hasNativeArguments &&
            (method is ConstructorInfo || method.IsGenericMethod || !HasValidatedForeignContract(method)) {
            diagnostics.ReportNativeProtocol(
                location,
                "native arguments require a nongeneric metadata-aware G# contract; general foreign export is blocked"
            )
        }
    }

    private func ValidateForeignStorage(
        field FieldInfo,
        hasNativeStorage bool,
        location TextLocation,
        diagnostics DiagnosticBag
    ) {
        if hasNativeStorage && (field.DeclaringType is not{} owner || !HasValidatedForeignContract(owner)) {
            diagnostics.ReportNativeProtocol(
                location,
                "native field access requires a metadata-aware G# storage contract; general foreign export is blocked"
            )
        }
    }

    private func HasValidatedForeignContract(member MemberInfo) bool ->
    NativeProtocolMetadata.HasSupportedFeatureMarker(member) &&
        NativeProtocolMetadata
        .Read(member.Module.Assembly)
        .Manifest
        .ValueKind !=
    System.Text.Json.JsonValueKind.Undefined

    private func IsEqualityMember(name string) bool ->
    name is "Equals" or "GetHashCode" or "op_Equality" or "op_Inequality"

    private func IsNil(value BoundExpression) bool -> switch value {
        case conversion is BoundConversionExpression: IsNil(conversion.Expression)
        case literal is BoundLiteralExpression: literal.Value == nil
        case defaultValue is BoundDefaultExpression:
        defaultValue.Type is NullableTypeSymbol && NativeProtocolOperations.GetProtocol(defaultValue.Type) != nil
        default: value.Type == TypeSymbol.Null
    }
}
