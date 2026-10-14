// <copyright file="SymbolDocumentationIdProvider.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Documentation

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Text

internal shared class SymbolDocumentationIdProvider {
    func GetDocumentationId(symbol Symbol) string? {
        return switch symbol {
            case package_ is PackageSymbol: GetDocumentationId($package: package_)
            case type is TypeSymbol when IsSourceNamedType(type): GetDocumentationId(type: type)
            case enumMember is EnumMemberSymbol: GetDocumentationId(member: enumMember)
            case function is FunctionSymbol: GetDocumentationId(function: function)
            default: default(string?)
        }
    }

    func GetDocumentationId(member Symbol, ownerType TypeSymbol?) string? {
        return switch member {
            case field is FieldSymbol: GetDocumentationId(field: field, ownerType: ownerType)
            case property is PropertySymbol: GetDocumentationId(property: property, ownerType: ownerType)
            case event is EventSymbol: GetDocumentationId(event: event, ownerType: ownerType)
            case function is FunctionSymbol: GetDocumentationId(function: function)
            default: default(string?)
        }
    }

    internal func GetDocumentationId($package PackageSymbol?) string? {
        return if $package == nil {
            default(string?)
        } else {
            "N:${$package.Name}"
        }
    }

    internal func GetDocumentationId(type TypeSymbol?) string? {
        if type == nil || !IsSourceNamedType(type) {
            return nil
        }
        let builder = StringBuilder("T:")
        AppendTypeDeclarationName(builder, type)
        return builder.ToString()
    }

    internal func GetDocumentationId(function FunctionSymbol?) string? {
        if function == nil {
            return nil
        }
        let builder = StringBuilder("M:")
        let candidateOwner TypeSymbol? = function.ReceiverType ?? function.StaticOwnerType
        let ownerType TypeSymbol? = if candidateOwner != nil && IsSourceNamedType(candidateOwner) {
            candidateOwner
        } else {
            default(TypeSymbol?)
        }
        if ownerType != nil {
            AppendTypeDeclarationName(builder, ownerType)
        } else if !string.IsNullOrEmpty(function.Package?.Name) {
            builder.Append(function.Package!!.Name)
        } else {
            return nil
        }
        builder.Append('.')
        AppendMethodName(builder, function)
        if !IsConstructor(function) && function.TypeParameters.Length > 0 {
            builder.Append("``").Append(function.TypeParameters.Length)
        }
        AppendParameterList(builder, function, ownerType)
        if string.Equals(function.Name, "op_Implicit", StringComparison.Ordinal) || string.Equals(
            function.Name,
            "op_Explicit",
            StringComparison.Ordinal
        ) {
            builder.Append('~')
            AppendTypeReference(builder, function.Type, ownerType, function)
        }
        return builder.ToString()
    }

    private func GetDocumentationId(field FieldSymbol?, ownerType TypeSymbol?) string? {
        if field == nil || ownerType == nil {
            return nil
        }
        let builder = StringBuilder("F:")
        AppendTypeDeclarationName(builder, ownerType)
        builder.Append('.').Append(EncodeName(field.Name))
        return builder.ToString()
    }

    private func GetDocumentationId(property PropertySymbol?, ownerType TypeSymbol?) string? {
        if property == nil || ownerType == nil {
            return nil
        }
        let builder = StringBuilder("P:")
        AppendTypeDeclarationName(builder, ownerType)
        builder.Append('.').Append(EncodeName(property.Name))
        AppendParameterList(builder, property.Parameters, ownerType)
        return builder.ToString()
    }

    private func GetDocumentationId(event EventSymbol?, ownerType TypeSymbol?) string? {
        if event == nil || ownerType == nil {
            return nil
        }
        let builder = StringBuilder("E:")
        AppendTypeDeclarationName(builder, ownerType)
        builder.Append('.').Append(EncodeName(event.Name))
        return builder.ToString()
    }

    private func GetDocumentationId(member EnumMemberSymbol?) string? {
        if member == nil {
            return nil
        }
        let builder = StringBuilder("F:")
        AppendTypeDeclarationName(builder, member.EnumType)
        builder.Append('.').Append(EncodeName(member.Name))
        return builder.ToString()
    }

    private func AppendMethodName(builder StringBuilder, function FunctionSymbol) {
        if IsConstructor(function) {
            builder.Append(
                if IsStaticConstructor(function) {
                    "#cctor"
                } else {
                    "#ctor"
                }
            )
            return
        }
        builder.Append(EncodeName(function.Name))
    }

    private func AppendParameterList(builder StringBuilder, function FunctionSymbol, ownerType TypeSymbol?) {
        let start = if function.ReceiverType != nil && function.ExplicitReceiverParameter != nil {
            1
        } else {
            0
        }
        if function.Parameters.Length <= start {
            return
        }
        builder.Append('(')
        for var i = start; i < function.Parameters.Length; i++ {
            if i > start {
                builder.Append(',')
            }
            AppendTypeReference(builder, function.Parameters[i].Type, ownerType, function)
            // ADR-0060 item #8: Roslyn DocID convention appends '@' for any
            // by-ref parameter ('ref', 'out', and 'in' all encode identically
            // in the DocID; the 'in' / 'out' distinction is recorded only via
            // ParameterAttributes on the metadata row).
            if function.Parameters[i].RefKind != RefKind.None {
                builder.Append('@')
            }
        }
        builder.Append(')')
    }

    private func AppendParameterList(
        builder StringBuilder,
        parameters ImmutableArray[ParameterSymbol],
        ownerType TypeSymbol?
    ) {
        if parameters.IsDefaultOrEmpty {
            return
        }
        builder.Append('(')
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, parameters[i].Type, ownerType, function: nil)
            if parameters[i].RefKind != RefKind.None {
                builder.Append('@')
            }
        }
        builder.Append(')')
    }

    private func AppendTypeDeclarationName(builder StringBuilder, type TypeSymbol) {
        let chain = SourceNestingChain(GetSourceDefinition(type))
        if chain.Count == 0 {
            builder.Append(EncodeName(type.Name))
            return
        }
        let packageName = GetPackageName(chain[0])
        if !string.IsNullOrEmpty(packageName) {
            builder.Append(packageName).Append('.')
        }
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(EncodeName(level.Name))
            let arity = GetOwnArity(level)
            if arity > 0 {
                builder.Append('`').Append(arity)
            }
        }
    }

    private func AppendTypeReference(
        builder StringBuilder,
        type TypeSymbol,
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        switch type {
            case nil {
                builder.Append("System.Void")
                return
            }
            case typeParameter is TypeParameterSymbol {
                if IsMethodTypeParameter(typeParameter, function) {
                    builder.Append("``").Append(typeParameter.Ordinal)
                } else {
                    builder.Append('`').Append(GetTypeParameterOrdinal(typeParameter, ownerType))
                }
                return
            }
            case arrayType is ArrayTypeSymbol {
                AppendTypeReference(builder, arrayType.ElementType, ownerType, function)
                builder.Append("[]")
                return
            }
            case rectangularArrayType is RectangularArrayTypeSymbol {
                AppendTypeReference(builder, rectangularArrayType.ElementType, ownerType, function)
                builder.Append('[')
                for var i = 0; i < rectangularArrayType.Rank; i++ {
                    if i > 0 {
                        builder.Append(',')
                    }
                    builder.Append("0:")
                }
                builder.Append(']')
                return
            }
            case sliceType is SliceTypeSymbol {
                // #611: a slice `[]T` is backed by CLR `T[]`, so its
                // documentation ID uses the same array encoding.
                AppendTypeReference(builder, sliceType.ElementType, ownerType, function)
                builder.Append("[]")
                return
            }
            case byRefType is ByRefTypeSymbol {
                AppendTypeReference(builder, byRefType.PointeeType, ownerType, function)
                builder.Append('@')
                return
            }
            case nullableType is NullableTypeSymbol {
                if NullableLifting.IsAnyValueTypeNullable(nullableType) {
                    builder.Append("System.Nullable{")
                    AppendTypeReference(builder, nullableType.UnderlyingType, ownerType, function)
                    builder.Append('}')
                } else {
                    AppendTypeReference(builder, nullableType.UnderlyingType, ownerType, function)
                }
                return
            }
            case pointerType is PointerTypeSymbol {
                AppendTypeReference(builder, pointerType.PointeeType, ownerType, function)
                builder.Append('*')
                return
            }
            case tupleType is TupleTypeSymbol {
                AppendTupleTypeReference(builder, tupleType.ElementTypes, 0, tupleType.Arity, ownerType, function)
                return
            }
            case functionType is FunctionTypeSymbol {
                AppendFunctionTypeReference(builder, functionType, ownerType, function)
                return
            }
            case structType is StructSymbol {
                AppendSourceTypeReference(builder, structType, ownerType, function)
                return
            }
            case interfaceType is InterfaceSymbol {
                AppendSourceTypeReference(builder, interfaceType, ownerType, function)
                return
            }
            case enumType is EnumSymbol {
                AppendSourceTypeReference(builder, enumType, ownerType, function)
                return
            }
            case delegateType is DelegateTypeSymbol {
                AppendSourceTypeReference(builder, delegateType, ownerType, function)
                return
            }
            case importedType is ImportedTypeSymbol when importedType.OpenDefinition != nil &&
                !importedType
                .TypeArguments
                .IsDefaultOrEmpty {
                AppendClrConstructedTypeReference(
                    builder,
                    importedType.OpenDefinition!!,
                    importedType.TypeArguments,
                    ownerType,
                    function
                )
                return
            }
            case importedType is ImportedTypeSymbol when importedType.Type != nil {
                AppendClrTypeReference(builder, importedType.Type)
                return
            }
            default {
                if type.ClrType != nil {
                    AppendClrTypeReference(builder, type.ClrType)
                } else {
                    builder.Append(EncodeName(type.Name))
                }
                return
            }
        }
    }

    private func AppendTupleTypeReference(
        builder StringBuilder,
        elementTypes ImmutableArray[TypeSymbol],
        start int32,
        count int32,
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        // TupleTypeSymbol retains only positional element types, which also
        // erases tuple element names as required by XML documentation IDs.
        builder.Append("System.ValueTuple{")
        let directCount = Math.Min(count, 7)
        for var i = 0; i < directCount; i++ {
            if i > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, elementTypes[start + i], ownerType, function)
        }
        if count > 7 {
            builder.Append(',')
            AppendTupleTypeReference(builder, elementTypes, start + 7, count - 7, ownerType, function)
        }
        builder.Append('}')
    }

    private func AppendFunctionTypeReference(
        builder StringBuilder,
        type FunctionTypeSymbol,
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        let returnsVoid = object.ReferenceEquals(type.ReturnType, TypeSymbol.Void)
        builder.Append(
            if returnsVoid {
                "System.Action"
            } else {
                "System.Func"
            }
        )
        let argumentCount = type
            .ParameterTypes
            .Length +
            (
            if returnsVoid {
                0
            } else {
                1
            }
        )
        if argumentCount == 0 {
            return
        }
        builder.Append('{')
        for var i = 0; i < type.ParameterTypes.Length; i++ {
            if i > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, type.ParameterTypes[i], ownerType, function)
        }
        if !returnsVoid {
            if type.ParameterTypes.Length > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, type.ReturnType, ownerType, function)
        }
        builder.Append('}')
    }

    private func AppendSourceTypeReference(
        builder StringBuilder,
        type TypeSymbol,
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        let chain = SourceNestingChain(GetSourceDefinition(type))
        if chain.Count == 0 {
            builder.Append(EncodeName(type.Name))
            return
        }
        let packageName = GetPackageName(chain[0])
        if !string.IsNullOrEmpty(packageName) {
            builder.Append(packageName).Append('.')
        }
        let enclosingArguments = GetEnclosingTypeArguments(type)
        let ownArguments = GetOwnTypeArguments(type)
        var enclosingArgumentIndex = 0
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(EncodeName(level.Name))
            let arity = GetOwnArity(level)
            if arity == 0 {
                continue
            }
            if i < chain.Count - 1 && enclosingArgumentIndex + arity <= enclosingArguments.Length {
                AppendSourceTypeArguments(
                    builder,
                    enclosingArguments,
                    enclosingArgumentIndex,
                    arity,
                    ownerType,
                    function
                )
                enclosingArgumentIndex += arity
                continue
            }
            if i == chain.Count - 1 && ownArguments.Length == arity {
                AppendSourceTypeArguments(builder, ownArguments, 0, arity, ownerType, function)
                continue
            }
            if TryGetOwnerGenericOffset(level, ownerType, out var ownerOffset) {
                builder.Append('{')
                for var a = 0; a < arity; a++ {
                    if a > 0 {
                        builder.Append(',')
                    }
                    builder.Append('`').Append(ownerOffset + a)
                }
                builder.Append('}')
                continue
            }
            builder.Append('`').Append(arity)
        }
    }

    private func AppendSourceTypeArguments(
        builder StringBuilder,
        arguments ImmutableArray[TypeSymbol],
        start int32,
        count int32,
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        builder.Append('{')
        for var i = 0; i < count; i++ {
            if i > 0 {
                builder.Append(',')
            }
            AppendTypeReference(builder, arguments[start + i], ownerType, function)
        }
        builder.Append('}')
    }

    private func IsSourceNamedType(type TypeSymbol) bool {
        return type is StructSymbol || type is InterfaceSymbol || type is EnumSymbol || type is DelegateTypeSymbol
    }

    private func GetSourceDefinition(type TypeSymbol) TypeSymbol {
        return switch type {
            case structType is StructSymbol: cast[TypeSymbol](structType.Definition ?? structType)
            case interfaceType is InterfaceSymbol: cast[TypeSymbol](interfaceType.Definition ?? interfaceType)
            case enumType is EnumSymbol: cast[TypeSymbol](enumType.Definition ?? enumType)
            case delegateType is DelegateTypeSymbol: cast[TypeSymbol](delegateType.Definition ?? delegateType)
            default: type
        }
    }

    private func GetContainingSourceType(type TypeSymbol) TypeSymbol? {
        return switch type {
            case structType is StructSymbol: structType.ContainingType
            case interfaceType is InterfaceSymbol: interfaceType.ContainingType
            case enumType is EnumSymbol: enumType.ContainingType
            default: default(TypeSymbol?)
        }
    }

    private func SourceNestingChain(type TypeSymbol) List[TypeSymbol] {
        let chain = List[TypeSymbol]()
        for var current TypeSymbol? = GetSourceDefinition(type);
            current != nil;
            current = if GetContainingSourceType(current!!) is {} containing {
            GetSourceDefinition(containing)
        } else {
            default(TypeSymbol?)
        } {
            chain.Insert(0, current)
        }
        return chain
    }

    private func GetPackageName(type TypeSymbol) string {
        return switch type {
            case structType is StructSymbol: structType.PackageName
            case interfaceType is InterfaceSymbol: interfaceType.PackageName
            case enumType is EnumSymbol: enumType.PackageName
            case delegateType is DelegateTypeSymbol: delegateType.PackageName
            default: string.Empty
        }
    }

    private func GetOwnArity(type TypeSymbol) int32 {
        return switch type {
            case StructSymbol{Declaration: {} declaration}: declaration.TypeParameterList?.Parameters.Count ?? 0
            case structType is StructSymbol: structType.TypeParameters.Length
            case InterfaceSymbol{Declaration: {} declaration}: declaration.TypeParameterList?.Parameters.Count ?? 0
            case interfaceType is InterfaceSymbol: interfaceType.TypeParameters.Length
            case DelegateTypeSymbol{Declaration: {} declaration}: declaration.TypeParameterList?.Parameters.Count ?? 0
            case delegateType is DelegateTypeSymbol: delegateType.TypeParameters.Length
            default: 0
        }
    }

    private func GetEnclosingTypeArguments(type TypeSymbol) ImmutableArray[TypeSymbol] {
        return switch type {
            case structType is StructSymbol: structType.EnclosingTypeArguments
            case enumType is EnumSymbol: enumType.EnclosingTypeArguments
            default: ImmutableArray[TypeSymbol].Empty
        }
    }

    private func GetOwnTypeArguments(type TypeSymbol) ImmutableArray[TypeSymbol] {
        return switch type {
            case structType is StructSymbol: structType.TypeArguments
            case interfaceType is InterfaceSymbol: interfaceType.TypeArguments
            case delegateType is DelegateTypeSymbol: delegateType.TypeArguments
            default: ImmutableArray[TypeSymbol].Empty
        }
    }

    private func TryGetOwnerGenericOffset(type TypeSymbol, ownerType TypeSymbol?, out offset int32) bool {
        offset = 0
        if ownerType == nil || !IsSourceNamedType(ownerType) {
            return false
        }
        for ownerLevel in SourceNestingChain(GetSourceDefinition(ownerType)) {
            if object.ReferenceEquals(GetSourceDefinition(ownerLevel), GetSourceDefinition(type)) {
                return true
            }
            offset += GetOwnArity(ownerLevel)
        }
        offset = 0
        return false
    }

    private func GetTypeParameterOrdinal(typeParameter TypeParameterSymbol, ownerType TypeSymbol?) int32 {
        if ownerType == nil || !IsSourceNamedType(ownerType) {
            return typeParameter.Ordinal
        }
        let chain = SourceNestingChain(GetSourceDefinition(ownerType))
        let offsets = [chain.Count]int32
        var offset = 0
        for var i = 0; i < chain.Count; i++ {
            offsets[i] = offset
            offset += GetOwnArity(chain[i])
        }
        for var i = chain.Count - 1; i >= 0; i-- {
            if DeclaresTypeParameter(chain[i], typeParameter) {
                return offsets[i] + typeParameter.Ordinal
            }
        }
        return typeParameter.Ordinal
    }

    private func DeclaresTypeParameter(type TypeSymbol, typeParameter TypeParameterSymbol) bool {
        if typeParameter.Ordinal < 0 {
            return false
        }
        for parameter in GetOwnTypeParameters(type) {
            if object.ReferenceEquals(parameter, typeParameter) || string.Equals(
                parameter.Name,
                typeParameter.Name,
                StringComparison.Ordinal
            ) {
                return true
            }
        }
        return false
    }

    private func GetOwnTypeParameters(type TypeSymbol) ImmutableArray[TypeParameterSymbol] {
        let parameters = switch type {
            case structType is StructSymbol: structType.TypeParameters
            case interfaceType is InterfaceSymbol: interfaceType.TypeParameters
            case delegateType is DelegateTypeSymbol: delegateType.TypeParameters
            default: ImmutableArray[TypeParameterSymbol].Empty
        }
        let ownArity = GetOwnArity(type)
        return if ownArity > 0 && parameters.Length > ownArity {
            parameters.Slice(parameters.Length - ownArity, ownArity)
        } else {
            parameters
        }
    }

    private func AppendClrTypeReference(builder StringBuilder, type Type?) {
        if type == nil {
            return
        }
        if type.IsByRef {
            AppendClrTypeReference(builder, type.GetElementType())
            builder.Append('@')
            return
        }
        if type.IsPointer {
            AppendClrTypeReference(builder, type.GetElementType())
            builder.Append('*')
            return
        }
        if type.IsArray {
            AppendClrTypeReference(builder, type.GetElementType())
            AppendArraySuffix(builder, type)
            return
        }
        if type.IsGenericParameter {
            builder.Append(
                if type.DeclaringMethod != nil {
                    "``"
                } else {
                    "`"
                }
            )
                .Append(type.GenericParameterPosition)
            return
        }
        AppendClrConstructedTypeReference(builder, type)
    }

    private func AppendClrConstructedTypeReference(builder StringBuilder, type Type?) {
        let chain = NestingChain(type)
        let outermost = chain[0]
        if !string.IsNullOrEmpty(outermost.Namespace) {
            builder.Append(outermost.Namespace).Append('.')
        }
        // NestingChain returns an empty list for a null type, so the chain[0]
        // above would already have thrown; reaching here means type is present.
        let allArgs = if type!!.IsGenericType {
            type!!.GetGenericArguments()
        } else {
            Type.EmptyTypes
        }
        var consumed = 0
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(StripArity(level.Name))
            let arity = LevelArity(level)
            if arity == 0 {
                continue
            }
            if type!!.IsGenericTypeDefinition {
                builder.Append('`').Append(arity)
                continue
            }
            builder.Append('{')
            for var a = 0; a < arity; a++ {
                if a > 0 {
                    builder.Append(',')
                }
                AppendClrTypeReference(builder, allArgs[consumed + a])
            }
            builder.Append('}')
            consumed += arity
        }
    }

    private func AppendClrConstructedTypeReference(
        builder StringBuilder,
        openDefinition Type,
        typeArguments ImmutableArray[TypeSymbol],
        ownerType TypeSymbol?,
        function FunctionSymbol?
    ) {
        let chain = NestingChain(openDefinition)
        let outermost = chain[0]
        if !string.IsNullOrEmpty(outermost.Namespace) {
            builder.Append(outermost.Namespace).Append('.')
        }
        var consumed = 0
        for var i = 0; i < chain.Count; i++ {
            if i > 0 {
                builder.Append('.')
            }
            let level = chain[i]
            builder.Append(StripArity(level.Name))
            let arity = LevelArity(level)
            if arity == 0 {
                continue
            }
            builder.Append('{')
            for var a = 0; a < arity; a++ {
                if a > 0 {
                    builder.Append(',')
                }
                AppendTypeReference(builder, typeArguments[consumed + a], ownerType, function)
            }
            builder.Append('}')
            consumed += arity
        }
    }

    private func AppendArraySuffix(builder StringBuilder, array Type) {
        if array.IsSZArray {
            builder.Append("[]")
            return
        }
        let rank = array.GetArrayRank()
        builder.Append('[')
        for var i = 0; i < rank; i++ {
            if i > 0 {
                builder.Append(',')
            }
            builder.Append("0:")
        }
        builder.Append(']')
    }

    private func NestingChain(type Type?) List[Type] {
        let chain = List[Type]()
        for var current Type? = type; current != nil; current = current!!.DeclaringType {
            chain.Insert(0, current)
        }
        return chain
    }

    private func LevelArity(level Type) int32 {
        let own = if level.IsGenericType {
            level.GetGenericArguments().Length
        } else {
            0
        }
        let enclosing = if level.DeclaringType is {IsGenericType: true} declaring {
            declaring.GetGenericArguments().Length
        } else {
            0
        }
        return own - enclosing
    }

    private func StripArity(name string) string {
        let tick = name.IndexOf('`')
        return if tick >= 0 {
            name.Substring(0, tick)
        } else {
            name
        }
    }

    private func IsMethodTypeParameter(typeParameter TypeParameterSymbol, function FunctionSymbol?) bool {
        if function == nil || function.TypeParameters.IsDefaultOrEmpty {
            return false
        }
        for var i = 0; i < function.TypeParameters.Length; i++ {
            if object.ReferenceEquals(function.TypeParameters[i], typeParameter) {
                return true
            }
        }
        return false
    }

    private func IsConstructor(function FunctionSymbol) bool {
        return string.Equals(function.Name, ".ctor", StringComparison.Ordinal) || string.Equals(
            function.Name,
            "#ctor",
            StringComparison.Ordinal
        )
    }

    private func IsStaticConstructor(function FunctionSymbol) bool {
        return string.Equals(function.Name, ".cctor", StringComparison.Ordinal) || string.Equals(
            function.Name,
            "#cctor",
            StringComparison.Ordinal
        )
    }

    private func EncodeName(name string) string {
        return name.Replace('.', '#').Replace('<', '{').Replace('>', '}').Replace(',', '@')
    }
}
