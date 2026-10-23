// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

internal shared class NativeProtocolSafety {
    internal func ContainsSavedProtocol(type TypeSymbol, visited HashSet[TypeSymbol]? = nil) bool {
        if ContainsProtocol(type) {
            return true
        }
        let seen = visited ?? HashSet[TypeSymbol]()
        if type is NullableTypeSymbol nullable {
            return ContainsSavedProtocol(nullable.UnderlyingType, seen)
        }
        if type is StructSymbol aggregate {
            // Inspect argument dependencies before cutting the finite definition graph.
            // Node[T] -> Node[[]T] must not create an unbounded constructed-type walk.
            if TypeArguments(type).Any((argument TypeSymbol) -> ContainsSavedProtocol(argument, seen)) {
                return true
            }
            if !seen.Add(aggregate.Definition) {
                return false
            }
            return aggregate.BaseType is {} parent &&
                ContainsSavedProtocol(parent, seen) ||
                aggregate
                .PrimaryConstructorParameters
                .Any((parameter ParameterSymbol) -> ContainsSavedProtocol(parameter.Type, seen)) ||
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
                .Any(
                (field FieldSymbol) ->
                ContainsSavedProtocol(field.Type, seen)
            ) ||
                aggregate.ClrType is {} importedAggregate &&
                NativeProtocolMetadata.HasFeatureMarker(importedAggregate)
        }
        if !seen.Add(type) {
            return false
        }
        if type is ArrayTypeSymbol array {
            return ContainsSavedProtocol(array.ElementType, seen)
        }
        if type is SliceTypeSymbol slice {
            return ContainsSavedProtocol(slice.ElementType, seen)
        }
        if type is RectangularArrayTypeSymbol rectangular {
            return ContainsSavedProtocol(rectangular.ElementType, seen)
        }
        if type is ChannelTypeSymbol channel {
            return ContainsSavedProtocol(channel.ElementType, seen)
        }
        if type is SequenceTypeSymbol sequenceType {
            return ContainsSavedProtocol(sequenceType.ElementType, seen)
        }
        if type is MapTypeSymbol mapType {
            return ContainsSavedProtocol(mapType.KeyType, seen) || ContainsSavedProtocol(mapType.ValueType, seen)
        }
        if type is TupleTypeSymbol tuple {
            return tuple.ElementTypes.Any((element TypeSymbol) -> ContainsSavedProtocol(element, seen))
        }
        if type is FunctionTypeSymbol function {
            return ContainsSavedProtocol(function.ReturnType, seen) || function.ParameterTypes.Any(
                (parameter TypeSymbol) -> ContainsSavedProtocol(parameter, seen)
            )
        }
        if TypeArguments(type).Any((argument TypeSymbol) -> ContainsSavedProtocol(argument, seen)) {
            return true
        }
        return type.ClrType is {} imported && NativeProtocolMetadata.HasFeatureMarker(imported)
    }

    internal func ContainsProtocol(type TypeSymbol) bool {
        if NativeProtocolOperations.GetProtocol(type) != nil {
            return true
        }
        if type is NullableTypeSymbol nullable {
            return ContainsProtocol(nullable.UnderlyingType)
        }
        if type is FunctionTypeSymbol function {
            return ContainsProtocol(function.ReturnType) || function.ParameterTypes.Any(ContainsProtocol)
        }
        if type is ArrayTypeSymbol array {
            return ContainsProtocol(array.ElementType)
        }
        if type is SliceTypeSymbol slice {
            return ContainsProtocol(slice.ElementType)
        }
        if type is RectangularArrayTypeSymbol rectangular {
            return ContainsProtocol(rectangular.ElementType)
        }
        if type is ChannelTypeSymbol channel {
            return ContainsProtocol(channel.ElementType)
        }
        if type is SequenceTypeSymbol sequenceType {
            return ContainsProtocol(sequenceType.ElementType)
        }
        if type is MapTypeSymbol mapType {
            return ContainsProtocol(mapType.KeyType) || ContainsProtocol(mapType.ValueType)
        }
        if type is TupleTypeSymbol tuple {
            return tuple.ElementTypes.Any(ContainsProtocol)
        }
        return TypeArguments(type).Any(ContainsProtocol)
    }

    private func TypeArguments(type TypeSymbol) ImmutableArray[TypeSymbol] -> switch type {
        case aggregate is StructSymbol: aggregate.TypeArguments.AddRange(aggregate.EnclosingTypeArguments)
        case contract is InterfaceSymbol: contract.TypeArguments
        default: type.ConstructedTypeArguments
    }

    internal func ValidateSignature(function FunctionSymbol, diagnostics DiagnosticBag) {
        let location = function.Declaration?.Location ?? default(TextLocation)
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

    internal func ValidatePublicContractType(type TypeSymbol, location TextLocation, diagnostics DiagnosticBag) {
        if NativeProtocolOperations.GetProtocol(type) is {} protocol && !NativeProtocolMetadata.IsPublic(protocol) {
            diagnostics.ReportNativeProtocol(location, "public native signatures require accessible contract types")
        }
        for position in type.GetElementPositions() {
            ValidatePublicContractType(position, location, diagnostics)
        }
    }

    internal func ValidateStorageType(type TypeSymbol, location TextLocation, diagnostics DiagnosticBag) {
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
        if (
            type is FunctionTypeSymbol ||
                type is MapTypeSymbol ||
                type is ChannelTypeSymbol ||
                type is SequenceTypeSymbol ||
                !TypeArguments(type).IsDefaultOrEmpty
        ) &&
            ContainsProtocol(type) {
            diagnostics.ReportNativeProtocol(
                location,
                "native protocol delegate/generic container contracts are not admitted by this core"
            )
        }
    }

    internal func ValidateExpression(node BoundExpression, diagnostics DiagnosticBag, anchor SyntaxNode?) {
        let location = (anchor ?? node.Syntax)?.Location ?? default(TextLocation)
        ValidateStorageType(node.Type, location, diagnostics)
        switch node {
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
            case conversion is BoundConversionExpression when
            ContainsSavedProtocol(conversion.Expression.Type) && !ContainsSavedProtocol(conversion.Type) {
                diagnostics.ReportNativeProtocol(
                    location,
                    "native protocol values cannot escape through object, nominal or generic conversions"
                )
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
