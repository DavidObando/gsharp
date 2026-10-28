// <copyright file="SymbolDisplay.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols.Display

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Globalization
import System.Linq
import System.Reflection
import System.Text

/// Produces a classified, declaratively-formatted display of a (cref:Symbol)
/// for IDE features (LSP hover, signature help, completion detail). This is the
/// single source of truth for IDE symbol rendering — the analog of Roslyn's
/// `ISymbolDisplayService` — so the language server never maintains divergent
/// ad-hoc formatters.
/// @remarks This service intentionally renders a richer, IDE-oriented view than
/// (cref:SymbolPrinter), which produces the terse, classified output used by
/// diagnostics and (cref:Symbol.ToString). The two serve different audiences
/// and are not duplicate logic.
shared class SymbolDisplay {
    private class PartBuilder {
        private let parts ImmutableArray[SymbolDisplayPart].Builder = ImmutableArray.CreateBuilder[SymbolDisplayPart]()
        func Add(kind SymbolDisplayPartKind, text string, symbol Symbol? = nil) -> this.parts.Add(
            SymbolDisplayPart(kind, text, symbol)
        )

        func Keyword(text string) -> this.Add(SymbolDisplayPartKind.Keyword, text)

        func Identifier(text string) -> this.Add(SymbolDisplayPartKind.Identifier, text)

        func Type(text string) -> this.Add(SymbolDisplayPartKind.TypeName, text)

        func Punctuation(text string) -> this.Add(SymbolDisplayPartKind.Punctuation, text)

        func Descriptor(text string) -> this.Add(SymbolDisplayPartKind.Descriptor, text)

        func Space() -> this.Add(SymbolDisplayPartKind.Space, " ")

        func ToImmutable() ImmutableArray[SymbolDisplayPart] -> this.parts.ToImmutable()
    }

    /// Renders [`symbol`](paramref) to a flat string under [`format`](paramref).
    /// @param symbol The symbol to render.
    /// @param format The display options.
    /// @param compilation An optional compilation used to recover a variable's exact declaring keyword.
    /// @returns The rendered display string.
    func ToDisplayString(symbol Symbol, format SymbolDisplayFormat, compilation Compilation? = nil) string {
        return PartsToString(ToDisplayParts(symbol, format, compilation))
    }

    /// Renders an imported CLR [`clrType`](paramref) to a flat string.
    /// @param clrType The reflected CLR type.
    /// @param format The display options.
    /// @returns The rendered display string.
    func ToDisplayString(clrType Type, format SymbolDisplayFormat) string {
        return PartsToString(ToDisplayParts(clrType: clrType, format: format))
    }

    /// Renders a reflected CLR [`member`](paramref) to a flat string.
    /// @param member The reflected CLR member.
    /// @param format The display options.
    /// @returns The rendered display string.
    func ToDisplayString(member MemberInfo, format SymbolDisplayFormat) string {
        return PartsToString(ToDisplayParts(member, format))
    }

    /// Renders a G# [`type`](paramref) without a declaration descriptor.
    /// @param type The type to render.
    /// @returns The source-compatible G# type name.
    func ToTypeDisplayString(type TypeSymbol) string {
        return FormatType(type)
    }

    /// Renders an imported CLR [`type`](paramref) without a declaration descriptor.
    /// @param type The reflected CLR type.
    /// @returns The source-compatible G# type name.
    func ToTypeDisplayString(type Type) string {
        return FormatClrTypeName(type, qualifyNames: true)
    }

    /// Renders an imported CLR [`type`](paramref) without a declaration descriptor, qualified or not.
    /// @param type The reflected CLR type.
    /// @param qualifyNames Whether to write the namespace of each type.
    /// @returns The source-compatible G# type name.
    func ToTypeDisplayString(type Type, qualifyNames bool) string {
        return FormatClrTypeName(type, qualifyNames)
    }

    /// Renders [`symbol`](paramref) to classified display parts under [`format`](paramref).
    /// @param symbol The symbol to render.
    /// @param format The display options.
    /// @param compilation An optional compilation used to recover a variable's exact declaring keyword.
    /// @returns The classified display parts.
    func ToDisplayParts(symbol Symbol?, format SymbolDisplayFormat, compilation Compilation? = nil) ImmutableArray[
        SymbolDisplayPart
    ] {
        if symbol == nil {
            return ImmutableArray[SymbolDisplayPart].Empty
        }
        let builder = PartBuilder()
        switch symbol {
            case parameter is ParameterSymbol {
                AppendVariableLike(
                    builder,
                    format,
                    SymbolDisplayPartKind.ParameterName,
                    "parameter",
                    parameter.Name,
                    parameter.Type
                )
            }
            case local is LocalVariableSymbol {
                AppendVariableLike(
                    builder,
                    format,
                    SymbolDisplayPartKind.Identifier,
                    "local variable",
                    local.Name,
                    local.Type
                )
            }
            case variable is VariableSymbol {
                AppendGlobalVariable(builder, format, variable, compilation)
            }
            case function is FunctionSymbol {
                AppendFunction(builder, format, function)
            }
            case aggregate is StructSymbol {
                AppendAggregate(builder, format, aggregate)
            }
            case enumSymbol is EnumSymbol {
                AppendEnum(builder, format, enumSymbol)
            }
            case member is EnumMemberSymbol {
                AppendEnumMember(builder, format, member)
            }
            case property is PropertySymbol {
                AppendProperty(builder, format, property)
            }
            case event is EventSymbol {
                AppendEvent(builder, event)
            }
            case field is FieldSymbol {
                AppendField(builder, format, field)
            }
            case import_ is ImportSymbol {
                AppendImport(builder, import_)
            }
            case package_ is PackageSymbol {
                AppendPackage(builder, package_)
            }
            case protocol is InterfaceSymbol when protocol.IsProtocol {
                builder.Keyword("protocol")
                builder.Space()
                builder.Type(FormatType(protocol))
            }
            case type is TypeSymbol {
                builder.Keyword("type")
                builder.Space()
                builder.Type(FormatType(type))
            }
            default {
                builder.Identifier(symbol.Name)
            }
        }
        return builder.ToImmutable()
    }

    /// Renders an imported CLR [`clrType`](paramref) to classified display parts.
    /// @param clrType The reflected CLR type.
    /// @param format The display options.
    /// @returns The classified display parts.
    func ToDisplayParts(clrType Type?, format SymbolDisplayFormat) ImmutableArray[SymbolDisplayPart] {
        let builder = PartBuilder()
        if clrType == nil {
            return builder.ToImmutable()
        }
        // ADR-0078: the aggregate kind keyword comes first.
        if clrType.IsInterface {
            builder.Keyword(
                if NativeProtocolMetadata.HasFeatureMarker(clrType) {
                    "protocol"
                } else {
                    "interface"
                }
            )
        } else if clrType.IsEnum {
            builder.Keyword("enum")
        } else if clrType.IsValueType {
            if IsByRefLikeType(clrType) {
                builder.Keyword("ref")
                builder.Space()
            }
            builder.Keyword("struct")
        } else {
            builder.Keyword("class")
        }
        builder.Space()
        builder.Type(FormatClrTypeName(clrType, format.QualifyNames))
        return builder.ToImmutable()
    }

    /// Renders a reflected CLR [`member`](paramref) to classified display parts.
    /// @param member The reflected CLR member.
    /// @param format The display options.
    /// @returns The classified display parts.
    func ToDisplayParts(member MemberInfo, format SymbolDisplayFormat) ImmutableArray[SymbolDisplayPart] {
        let builder = PartBuilder()
        switch member {
            case property is PropertyInfo {
                AppendClrProperty(builder, format, property)
            }
            case field is FieldInfo {
                AppendClrField(builder, format, field)
            }
            case event is EventInfo {
                AppendClrEvent(builder, format, event)
            }
            case method is MethodInfo {
                AppendClrMethod(builder, format, method)
            }
        }
        return builder.ToImmutable()
    }

    private func AppendVariableLike(
        builder PartBuilder,
        format SymbolDisplayFormat,
        nameKind SymbolDisplayPartKind,
        descriptor string,
        name string,
        type TypeSymbol
    ) {
        if format.IncludeDescriptorPrefix {
            builder.Descriptor("($descriptor)")
            builder.Space()
        }
        builder.Add(nameKind, name)
        builder.Space()
        builder.Type(FormatType(type))
    }

    private func AppendGlobalVariable(
        builder PartBuilder,
        format SymbolDisplayFormat,
        variable VariableSymbol,
        compilation Compilation?
    ) {
        builder.Keyword(ResolveVariableKeyword(variable, compilation))
        builder.Space()
        builder.Identifier(variable.Name)
        builder.Space()
        builder.Type(FormatType(variable.Type))
    }

    private func AppendFunction(builder PartBuilder, format SymbolDisplayFormat, function FunctionSymbol) {
        if format.IncludeModifiers {
            for modifier in FunctionModifiers(function) {
                builder.Keyword(modifier)
                builder.Space()
            }
        }
        builder.Keyword("func")
        builder.Space()
        if format.IncludeModifiers && function.ReceiverType != nil {
            builder.Punctuation("(")
            builder.Type(FormatType(function.ReceiverType))
            builder.Punctuation(")")
            builder.Space()
        }
        builder.Add(SymbolDisplayPartKind.MethodName, function.Name, function)
        AppendTypeParameters(builder, function.TypeParameters)
        builder.Punctuation("(")
        for var i = 0; i < function.Parameters.Length; i++ {
            if i > 0 {
                builder.Punctuation(",")
                builder.Space()
            }
            builder.Add(SymbolDisplayPartKind.ParameterName, function.Parameters[i].Name)
            builder.Space()
            builder.Type(FormatType(function.Parameters[i].Type))
        }
        builder.Punctuation(")")
        if !IsVoid(function.Type) {
            builder.Space()
            builder.Type(FormatType(function.Type))
        }
    }

    private func FunctionModifiers(function FunctionSymbol) sequence[string] {
        if function.IsStatic {
            yield "static"
        }
        if function.IsOpen {
            yield "open"
        }
        if function.IsOverride {
            yield "override"
        }
        if function.IsAsync {
            yield "async"
        }
        if function.IsSuspending {
            yield "suspend"
        }
    }

    private func AppendAggregate(builder PartBuilder, format SymbolDisplayFormat, aggregate StructSymbol) {
        // ADR-0078: the aggregate kind keyword IS the declaration head.
        // Render as `[ref]? [data]? [inline]? [open|sealed]? (class|struct) Name [TParams]? { fields }?`.
        if aggregate.IsRefStruct {
            builder.Keyword("ref")
            builder.Space()
        }
        if aggregate.IsData {
            builder.Keyword("data")
            builder.Space()
        }
        if aggregate.IsInline {
            builder.Keyword("inline")
            builder.Space()
        }
        builder.Keyword(
            if aggregate.IsClass {
                "class"
            } else {
                "struct"
            }
        )
        builder.Space()
        builder.Type(QualifiedName(format, aggregate.PackageName, FormatType(aggregate)))
        if !aggregate.Fields.IsEmpty {
            builder.Space()
            builder.Punctuation("{")
            builder.Space()
            for var i = 0; i < aggregate.Fields.Length; i++ {
                if i > 0 {
                    builder.Punctuation(";")
                    builder.Space()
                }
                builder.Keyword(
                    if aggregate.Fields[i].IsReadOnly {
                        "let"
                    } else {
                        "var"
                    }
                )
                builder.Space()
                builder.Add(SymbolDisplayPartKind.FieldName, aggregate.Fields[i].Name)
                builder.Space()
                builder.Type(FormatType(aggregate.Fields[i].Type))
            }
            builder.Space()
            builder.Punctuation("}")
        }
    }

    private func AppendEnum(builder PartBuilder, format SymbolDisplayFormat, enumSymbol EnumSymbol) {
        builder.Keyword("enum")
        builder.Space()
        builder.Type(QualifiedName(format, enumSymbol.PackageName, FormatType(enumSymbol)))
        builder.Space()
        builder.Punctuation("{")
        builder.Space()
        for var i = 0; i < enumSymbol.Members.Length; i++ {
            if i > 0 {
                builder.Punctuation(",")
                builder.Space()
            }
            builder.Add(SymbolDisplayPartKind.EnumMemberName, enumSymbol.Members[i].Name)
        }
        builder.Space()
        builder.Punctuation("}")
    }

    private func AppendEnumMember(builder PartBuilder, format SymbolDisplayFormat, member EnumMemberSymbol) {
        builder.Type(member.EnumType.Name)
        builder.Punctuation(".")
        builder.Add(SymbolDisplayPartKind.EnumMemberName, member.Name)
        if format.IncludeConstantValue {
            builder.Space()
            builder.Punctuation("=")
            builder.Space()
            builder.Add(SymbolDisplayPartKind.NumericLiteral, member.Value.ToString(CultureInfo.InvariantCulture))
        }
    }

    private func AppendProperty(builder PartBuilder, format SymbolDisplayFormat, property PropertySymbol) {
        builder.Keyword("prop")
        builder.Space()
        builder.Add(SymbolDisplayPartKind.PropertyName, property.Name)
        builder.Space()
        builder.Type(FormatType(property.Type))
        if format.IncludePropertyAccessors {
            builder.Space()
            builder.Punctuation("{")
            if property.HasGetter {
                builder.Space()
                builder.Keyword("get")
                builder.Punctuation(";")
            }
            if property.HasSetter {
                builder.Space()
                builder.Keyword("set")
                builder.Punctuation(";")
            }
            builder.Space()
            builder.Punctuation("}")
        }
    }

    private func AppendEvent(builder PartBuilder, event EventSymbol) {
        builder.Keyword("event")
        builder.Space()
        builder.Identifier(event.Name)
        builder.Space()
        builder.Type(FormatType(event.Type))
    }

    private func AppendField(builder PartBuilder, format SymbolDisplayFormat, field FieldSymbol) {
        if format.IncludeDescriptorPrefix {
            builder.Descriptor("(field)")
            builder.Space()
        }
        builder.Add(SymbolDisplayPartKind.FieldName, field.Name)
        builder.Space()
        builder.Type(FormatType(field.Type))
    }

    private func AppendImport(builder PartBuilder, $import ImportSymbol) {
        builder.Keyword("import")
        builder.Space()
        if $import.IsAlias {
            builder.Add(SymbolDisplayPartKind.AliasName, $import.Name)
            builder.Space()
            builder.Punctuation("=")
            builder.Space()
        }
        builder.Add(SymbolDisplayPartKind.NamespaceName, $import.Target)
    }

    private func AppendPackage(builder PartBuilder, $package PackageSymbol) {
        builder.Keyword("package")
        builder.Space()
        builder.Add(SymbolDisplayPartKind.NamespaceName, $package.Name)
    }

    private func AppendTypeParameters(builder PartBuilder, typeParameters ImmutableArray[TypeParameterSymbol]) {
        if typeParameters.IsDefaultOrEmpty {
            return
        }
        builder.Punctuation("[")
        for var i = 0; i < typeParameters.Length; i++ {
            if i > 0 {
                builder.Punctuation(",")
                builder.Space()
            }
            builder.Type(typeParameters[i].Name)
        }
        builder.Punctuation("]")
    }

    private func AppendClrProperty(builder PartBuilder, format SymbolDisplayFormat, property PropertyInfo) {
        builder.Add(
            SymbolDisplayPartKind.PropertyName,
            FormatClrMemberName(property.DeclaringType, property.Name, format)
        )
        builder.Space()
        builder.Type(FormatClrTypeName(property.PropertyType, format.QualifyNames))
        if format.IncludePropertyAccessors {
            builder.Space()
            builder.Punctuation("{")
            if property.CanRead {
                builder.Space()
                builder.Keyword("get")
                builder.Punctuation(";")
            }
            if property.CanWrite {
                builder.Space()
                builder.Keyword("set")
                builder.Punctuation(";")
            }
            builder.Space()
            builder.Punctuation("}")
        }
    }

    private func AppendClrField(builder PartBuilder, format SymbolDisplayFormat, field FieldInfo) {
        builder.Add(SymbolDisplayPartKind.FieldName, FormatClrMemberName(field.DeclaringType, field.Name, format))
        builder.Space()
        builder.Type(FormatClrTypeName(field.FieldType, format.QualifyNames))
    }

    private func AppendClrEvent(builder PartBuilder, format SymbolDisplayFormat, event EventInfo) {
        builder.Keyword("event")
        builder.Space()
        builder.Add(SymbolDisplayPartKind.Identifier, FormatClrMemberName(event.DeclaringType, event.Name, format))
        builder.Space()
        builder.Type(FormatClrTypeName(event.EventHandlerType, format.QualifyNames))
    }

    private func AppendClrMethod(builder PartBuilder, format SymbolDisplayFormat, method MethodInfo) {
        // ADR-0023 parity: a CLR method compiled from `async`/`await` exposes a
        // `Task[R]` (or `ValueTask[R]`) return in metadata, but G# renders async
        // functions as `async func ... R` with the awaited result type. Mirror
        // that here so an imported `async Task<R> M(...)` hovers as
        // `async func (T) M(...) R` rather than the leaked `func ... Task[R]`.
        let isAsync = format.IncludeModifiers && IsClrAsyncMethod(method)
        if isAsync {
            builder.Keyword("async")
            builder.Space()
        }
        builder.Keyword("func")
        builder.Space()
        if format.QualifyNames && method.DeclaringType != nil {
            builder.Punctuation("(")
            builder.Type(FormatClrTypeName(method.DeclaringType, qualifyNames: true))
            builder.Punctuation(")")
            builder.Space()
        }
        builder.Add(SymbolDisplayPartKind.MethodName, method.Name)
        builder.Punctuation("(")
        // The hidden context parameter of a suspending G# method is not a parameter a caller supplies.
        let parameters = ImportedFunctionSymbol.GetLogicalParameters(method)
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                builder.Punctuation(",")
                builder.Space()
            }
            builder.Add(SymbolDisplayPartKind.ParameterName, parameters[i].Name ?? string.Empty)
            builder.Space()
            builder.Type(FormatClrTypeName(parameters[i].ParameterType, format.QualifyNames))
        }
        builder.Punctuation(")")
        let returnType = if isAsync {
            UnwrapTaskReturnType(method.ReturnType)
        } else {
            method.ReturnType
        }
        if returnType is {} nonVoidReturnType && !nonVoidReturnType.IsSameAs(typeof(Void)) {
            builder.Space()
            builder.Type(FormatClrTypeName(nonVoidReturnType, format.QualifyNames))
        }
    }

    /// Returns `true` when a reflected CLR method was compiled from an
    /// `async` method (carries `AsyncStateMachineAttribute`). Uses
    /// (cref:MemberInfo.GetCustomAttributesData) rather than the generic
    /// `GetCustomAttribute<T>()` so it works for methods loaded
    /// through a `MetadataLoadContext` (the production `gsc` reference
    /// path), where reflection-only types cannot be matched by runtime identity.
    private func IsClrAsyncMethod(method MethodInfo) bool {
        for attribute in method.GetCustomAttributesData() {
            if attribute.AttributeType?.FullName == "System.Runtime.CompilerServices.AsyncStateMachineAttribute" {
                return true
            }
        }
        return false
    }

    /// Unwraps the awaited result type of an async return: `Task[R]` /
    /// `ValueTask[R]` resolve to `R`, the non-generic `Task` /
    /// `ValueTask` resolve to `void`, and any other shape (e.g. an
    /// async `IAsyncEnumerable[T]` iterator, or `async void`) is
    /// returned unchanged. FullName matching keeps this correct under a
    /// `MetadataLoadContext`.
    private func UnwrapTaskReturnType(returnType Type?) Type? {
        if returnType == nil {
            return nil
        }
        if returnType.IsGenericType && !returnType.IsGenericTypeDefinition {
            let definitionName = returnType.GetGenericTypeDefinition()?.FullName
            if definitionName == "System.Threading.Tasks.Task`1" ||
                definitionName == "System.Threading.Tasks.ValueTask`1" {
                return returnType.GetGenericArguments()[0]
            }
            return returnType
        }
        return if returnType.FullName == "System.Threading.Tasks.Task" ||
            returnType.FullName == "System.Threading.Tasks.ValueTask" {
            typeof(Void)
        } else {
            returnType
        }
    }

    private func QualifiedName(format SymbolDisplayFormat, packageName string, name string) string {
        // "Default" is G#'s implicit package (the analog of C#'s global namespace);
        // qualifying with it is noise, so it is treated as unqualified.
        return if format.QualifyNames && !string.IsNullOrEmpty(packageName) && packageName != "Default" {
            "$packageName.$name"
        } else {
            name ?? string.Empty
        }
    }

    private func FormatType(type TypeSymbol?) string {
        if type == nil || IsVoid(type) {
            return "void"
        }
        if !(type is NullableTypeSymbol) && ByteStringTypes.IsDefinition(type.ClrType) {
            return "bytestring"
        }
        if !(type is NullableTypeSymbol) && NativeSliceTypes.TryGetElement(
            type,
            out var sliceElement,
            out var readOnlySlice
        ) {
            return "${(if readOnlySlice { "readonly " } else { string.Empty })}slice[${FormatType(sliceElement)}]"
        }
        if ManagedReferenceTypes.TryGetElement(type, out var managedElement, out var readOnlyManaged) {
            return "${(if readOnlyManaged { "readonly " } else { string.Empty })}managed[${FormatType(managedElement)}]"
        }
        // Reconstruct the display name from the type's structure rather than
        // returning the raw TypeSymbol.Name. For constructed generics backed by
        // a CLR type (e.g. Task[string]) that raw name is the assembly-qualified
        // Type.FullName (`System.Threading.Tasks.Task`1[[System.String, ...]]`),
        // which leaks into hover. Recursing also keeps wrapper syntax in G# form
        // (`[]T`, `T?`, `sequence[T]`, ...) while rendering imported element
        // types nicely.
        switch type {
            case nullable is NullableTypeSymbol {
                // Issue #2160: a nullable function type must wrap the whole
                // arrow shape in parentheses so the `?` applies to the function
                // type and not just its return type (`((int32) -> void)?`,
                // never `(int32) -> void?`). Because FormatType recurses,
                // parenthesizing here also fixes nested occurrences (slice
                // element, generic arg, tuple element). Non-function nullable
                // types are rendered unchanged.
                if nullable.UnderlyingType is SliceTypeSymbol nullableSlice {
                    return "[]?${FormatType(nullableSlice.ElementType)}"
                }
                if nullable.UnderlyingType is ArrayTypeSymbol nullableArray {
                    return "[${nullableArray.Length}]?${FormatType(nullableArray.ElementType)}"
                }
                if nullable.UnderlyingType is RectangularArrayTypeSymbol nullableRectangular {
                    return "[${String(',', nullableRectangular.Rank - 1)}]?${FormatType(nullableRectangular.ElementType)}"
                }
                // Issue #4361 (review): an IMPORTED nullable array — an
                // annotated/imported CLR `T[]` under the `?`, which the
                // metadata reader produces for `string?[]`-shaped flags such
                // as `[2, 0]` — is not a `SliceTypeSymbol`, so it fell through
                // to the trailing-`?` form below and printed `[]string!?`
                // (or `[]string?`), ADR-0132's spelling of a slice of nullable
                // ELEMENTS. The positional form is `[]?string!`.
                if TryGetImportedArrayElement(nullable.UnderlyingType, out var nullableImportedElement) {
                    return "[]?${FormatType(nullableImportedElement)}"
                }
                let underlying = FormatType(nullable.UnderlyingType)
                return if nullable.UnderlyingType is FunctionTypeSymbol {
                    "($underlying)?"
                } else {
                    "$underlying?"
                }
            }
            case platform is PlatformTypeSymbol {
                // ADR-0186 §1: `T!` renders with the same POSITIONAL rule
                // ADR-0132 gives `?`, and it needs its own arm rather than
                // inheriting one — `[]!T` is a platform slice, `[]T!` a slice
                // of platform elements, and those are different types. A
                // platform function type parenthesises for issue #2160's
                // reason: `((int32) -> void)!`, never `(int32) -> void!`.
                if platform.UnderlyingType is SliceTypeSymbol platformSlice {
                    return "[]!${FormatType(platformSlice.ElementType)}"
                }
                if platform.UnderlyingType is ArrayTypeSymbol platformArray {
                    return "[${platformArray.Length}]!${FormatType(platformArray.ElementType)}"
                }
                if platform.UnderlyingType is RectangularArrayTypeSymbol platformRectangular {
                    return "[${String(',', platformRectangular.Rank - 1)}]!${FormatType(platformRectangular.ElementType)}"
                }
                // Issue #4361: an IMPORTED platform array (`string[]` read from
                // oblivious metadata) is not a `SliceTypeSymbol` — it is an
                // imported/annotated CLR array — so it used to fall through to
                // the trailing-`!` form and print `[]string!`, which is
                // ADR-0132's spelling of a slice of platform ELEMENTS: the
                // opposite type.
                if TryGetImportedArrayElement(platform.UnderlyingType, out var platformImportedElement) {
                    return "[]!${FormatType(platformImportedElement)}"
                }
                let platformUnderlying = FormatType(platform.UnderlyingType)
                return if platform.UnderlyingType is FunctionTypeSymbol {
                    "($platformUnderlying)!"
                } else {
                    "$platformUnderlying!"
                }
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                return if TryFormatWithPlatformArguments(annotated, out var withPlatformArguments) {
                    withPlatformArguments!!
                } else {
                    FormatType(annotated.BaseType)
                }
            }
            case function is FunctionTypeSymbol {
                return FormatFunctionType(function)
            }
            case functionPointer is FunctionPointerTypeSymbol {
                return FormatFunctionPointerType(functionPointer)
            }
            case array is ArrayTypeSymbol {
                return "[${array.Length}]${FormatType(array.ElementType)}"
            }
            case rectangular is RectangularArrayTypeSymbol {
                return "[${String(',', rectangular.Rank - 1)}]${FormatType(rectangular.ElementType)}"
            }
            case slice is SliceTypeSymbol {
                return "[]${FormatType(slice.ElementType)}"
            }
            case asyncSequence is AsyncSequenceTypeSymbol {
                // Issue #4020: an async sequence used to display as
                // `sequence[T]` — byte-identical to the SYNCHRONOUS
                // `SequenceTypeSymbol` below — so a diagnostic naming the type
                // could not be used to tell which of the two symbols the binder
                // actually held, and #4020's own GS0134 sent its first reader
                // to the wrong one. `async sequence[T]` is the spelling the
                // author writes for this type (ADR-0041), so it is both
                // unambiguous and round-trippable.
                return "async sequence[${FormatType(asyncSequence.ElementType)}]"
            }
            case sequence_ is SequenceTypeSymbol {
                return "sequence[${FormatType(sequence_.ElementType)}]"
            }
            case map_ is MapTypeSymbol {
                return "map[${FormatType(map_.KeyType)},${FormatType(map_.ValueType)}]"
            }
            case channel is ChannelTypeSymbol {
                return ChannelTypeSymbol.FormatName(FormatType(channel.ElementType), channel.Direction)
            }
            case pointer is PointerTypeSymbol {
                return "*${FormatType(pointer.PointeeType)}"
            }
            case byRef is ByRefTypeSymbol {
                return "*${FormatType(byRef.PointeeType)}"
            }
            case pinned is PinnedTypeSymbol {
                return "pinned ${FormatType(pinned.UnderlyingType)}"
            }
            case tuple is TupleTypeSymbol {
                // ADR-0172: render declared element names name-first,
                // matching the source spelling `(line int32, column int32)`.
                return "(" + string.Join(
                    ", ",
                    tuple.ElementTypes.Select(
                        (t TypeSymbol, i int32) -> if tuple.HasNames && tuple.ElementNames[i] is {} elementName {
                            "$elementName ${FormatType(t)}"
                        } else {
                            FormatType(t)
                        }
                    )
                ) +
                    ")"
            }
            case aggregate is StructSymbol when IsAnonymousClassType(aggregate) {
                // Issue #2224: an anonymous-class literal's synthesized type has
                // no separate declaration a user could hover to see its shape
                // (it has no source location — `Declaration` is null), so
                // render its member shape inline exactly like the
                // TupleTypeSymbol case above does for tuples. Rubber-duck
                // follow-up: members are get-only auto-properties, not plain
                // fields (see AnonymousTypeCache), so render Properties here.
                return "{ ${string.Join(", ", aggregate.Properties.Select((p PropertySymbol) -> "${p.Name}: ${FormatType(p.Type)}"))} }"
            }
            case aggregate is StructSymbol {
                return FormatSourceType(
                    aggregate.Definition?.Name ?? aggregate.Name,
                    aggregate.ContainingType,
                    aggregate.EnclosingTypeArguments,
                    GetDisplayTypeArguments(aggregate.TypeArguments, aggregate.TypeParameters)
                )
            }
            case enumSymbol is EnumSymbol {
                return FormatSourceType(
                    enumSymbol.Definition?.Name ?? enumSymbol.Name,
                    enumSymbol.ContainingType,
                    enumSymbol.EnclosingTypeArguments,
                    ImmutableArray[TypeSymbol].Empty
                )
            }
            case interface_ is InterfaceSymbol {
                return FormatSourceType(
                    interface_.Definition?.Name ?? interface_.Name,
                    interface_.ContainingType,
                    ImmutableArray[TypeSymbol].Empty,
                    GetDisplayTypeArguments(interface_.TypeArguments, interface_.TypeParameters)
                )
            }
            case delegateType is DelegateTypeSymbol {
                return FormatSourceType(
                    delegateType.Definition?.Name ?? delegateType.Name,
                    containingType: nil,
                    ImmutableArray[TypeSymbol].Empty,
                    GetDisplayTypeArguments(delegateType.TypeArguments, delegateType.TypeParameters)
                )
            }
            case imported is ImportedTypeSymbol {
                return FormatImportedType(imported)
            }
            default {
                return type.Name
            }
        }
    }

    /// Issue #4361: renders an annotated imported type from its
    /// <b>nullability-applied</b> arguments when — and only when — one of them
    /// is platform-typed.
    ///
    /// The annotated wrapper's own name is its base type's, so a nested
    /// argument's nullability never reached a diagnostic: `Arbitrary[Type!]`
    /// and `Arbitrary[Type]` both printed `Arbitrary[Type]`, and a
    /// conversion ADR-0186 §3 rule 3 correctly rejects read as
    /// <i>"Cannot convert type 'X' to 'X'"</i>. Platform-ness is exactly the
    /// case where the two sides can differ in nothing else, so it is the case
    /// rendered here, consistently with how a top-level `T!` is already
    /// displayed. (A nested `?` is left as before on purpose: surfacing
    /// it everywhere is a separate display change with a much wider blast
    /// radius, and nothing in the conversion rules turns on it alone.)
    /// @param annotated The annotated type.
    /// @param formatted The rendered name when this applies.
    /// @returns `true` when a nested argument is platform-typed.
    private func TryFormatWithPlatformArguments(
        annotated NullabilityAnnotatedTypeSymbol,
        @NotNullWhen(true) out formatted string?
    ) bool {
        formatted = nil
        let clr = annotated.ClrType
        if TryGetImportedArrayElement(annotated, out var element) {
            if !ContainsPlatformType(element) {
                return false
            }
            formatted = "[]${FormatType(element)}"
            return true
        }
        if !(clr != nil && clr.IsGenericType == true && clr.IsGenericTypeDefinition == false) {
            return false
        }
        let count = clr.GetGenericArguments().Length
        let arguments = ImmutableArray.CreateBuilder[TypeSymbol](count)
        var anyPlatform = false
        for var i = 0; i < count; i++ {
            let argument = annotated.GetTypeArgumentSymbol(i)
            anyPlatform |= ContainsPlatformType(argument)
            arguments.Add(argument)
        }
        if !anyPlatform {
            return false
        }
        // Only the platform-bearing arguments change spelling. A sibling with
        // no platform wrapper keeps the rendering it always had — its own
        // reference `?` stays unshown — so this path widens the display by
        // exactly the `!` it exists for and no more (review round 3).
        let displayArguments = arguments
            .MoveToImmutable()
            .Select(
            (argument TypeSymbol) -> if ContainsPlatformType(argument) {
                argument
            } else {
                StripReferenceNullable(argument)
            }
        )
            .ToImmutableArray()
        formatted = FormatImportedGenericTypeName(clr.GetGenericTypeDefinition(), displayArguments)
        return true
    }

    /// Removes a top-level reference-type `?` (a nullable VALUE type is a
    /// distinct CLR type and keeps its `?`), which is how a nested
    /// argument rendered before issue #4361's display change.
    /// @param type The argument type.
    /// @returns The argument without a reference-nullability wrapper.
    private func StripReferenceNullable(type TypeSymbol) TypeSymbol -> if type is NullableTypeSymbol{
        UnderlyingType: {} underlying
    } &&
        underlying
        .ClrType
        ?.IsValueType != true &&
        !((underlying is StructSymbol && underlying.IsClass == false || underlying is EnumSymbol)) {
        underlying
    } else {
        type
    }

    /// The element of an imported single-dimension CLR array, with the
    /// reader's nullability applied when the array is annotated.
    /// @param type The candidate array type.
    /// @param element The element type when it is one.
    /// @returns `true` for an imported rank-1 array.
    private func TryGetImportedArrayElement(type TypeSymbol, @NotNullWhen(true) out element TypeSymbol?) bool {
        element = nil
        if type.ClrType is not{IsArray: true} arrayClr || arrayClr.GetArrayRank() != 1 ||
            arrayClr.GetElementType() is not{} elementClr {
            return false
        }
        element = switch type {
            case annotated is NullabilityAnnotatedTypeSymbol: annotated.GetTypeArgumentSymbolForClrType(elementClr)
            case _ is ImportedTypeSymbol: TypeSymbol.FromClrTypeWithoutNullability(
                elementClr,
                NullabilityFreeReason.TypeStructure
            )
            default: default(TypeSymbol?)
        }
        return element != nil
    }

    /// Whether a platform wrapper appears anywhere in a displayed type's argument structure.
    /// @param type The type to scan.
    /// @returns `true` when a (cref:PlatformTypeSymbol) is present.
    private func ContainsPlatformType(type TypeSymbol?) bool {
        switch type {
            case nil {
                return false
            }
            case PlatformTypeSymbol {
                return true
            }
            case nullable is NullableTypeSymbol {
                return ContainsPlatformType(nullable.UnderlyingType)
            }
            case annotated is NullabilityAnnotatedTypeSymbol {
                if TryGetImportedArrayElement(annotated, out var element) {
                    return ContainsPlatformType(element)
                }
                if annotated.ClrType is {IsGenericType: true, IsGenericTypeDefinition: false} clr {
                    let count = clr.GetGenericArguments().Length
                    for var i = 0; i < count; i++ {
                        if ContainsPlatformType(annotated.GetTypeArgumentSymbol(i)) {
                            return true
                        }
                    }
                }
                return false
            }
            case slice is SliceTypeSymbol {
                return ContainsPlatformType(slice.ElementType)
            }
            case array is ArrayTypeSymbol {
                return ContainsPlatformType(array.ElementType)
            }
            case rectangular is RectangularArrayTypeSymbol {
                return ContainsPlatformType(rectangular.ElementType)
            }
            case map_ is MapTypeSymbol {
                return ContainsPlatformType(map_.KeyType) || ContainsPlatformType(map_.ValueType)
            }
            case tuple is TupleTypeSymbol {
                return tuple.ElementTypes.Any(ContainsPlatformType)
            }
            case ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
                return imported.TypeArguments.Any(ContainsPlatformType)
            }
            default {
                return false
            }
        }
    }

    /// Issue #2224: identifies a (cref:StructSymbol) synthesized by
    /// `AnonymousTypeCache` for an `object { let ... }`
    /// anonymous-class literal, as opposed to an ordinary user-declared
    /// struct/class. Anonymous types are unnameable in source (Roslyn's own
    /// synthesized anonymous types use the equivalent `<>f__AnonymousType`
    /// naming convention for the same reason) — matching the synthesized
    /// name prefix is the cheapest reliable signal without threading a new
    /// flag through every (cref:StructSymbol) constructor overload.
    /// @param type The struct symbol to check.
    /// @returns `true` if [`type`](paramref) is a synthesized anonymous-class type.
    private func IsAnonymousClassType(type StructSymbol) bool -> type.Declaration == nil && type.Name.StartsWith(
        "<>AnonymousType",
        StringComparison.Ordinal
    )

    private func FormatSourceType(
        name string,
        containingType TypeSymbol?,
        enclosingTypeArguments ImmutableArray[TypeSymbol],
        typeArguments ImmutableArray[TypeSymbol]
    ) string {
        var prefix = string.Empty
        if containingType != nil {
            prefix = if enclosingTypeArguments.IsDefaultOrEmpty {
                "${FormatType(containingType)}."
            } else {
                "${FormatContainingSourceType(containingType, enclosingTypeArguments)}."
            }
        }
        return prefix + name + FormatTypeArguments(typeArguments)
    }

    private func FormatContainingSourceType(
        containingType TypeSymbol?,
        enclosingTypeArguments ImmutableArray[TypeSymbol]
    ) string {
        if containingType is StructSymbol aggregate {
            let ownArgumentCount = Math.Min(aggregate.TypeParameters.Length, enclosingTypeArguments.Length)
            let outerArgumentCount = enclosingTypeArguments.Length - ownArgumentCount
            return FormatSourceType(
                aggregate.Name,
                aggregate.ContainingType,
                enclosingTypeArguments.Take(outerArgumentCount).ToImmutableArray(),
                enclosingTypeArguments.Skip(outerArgumentCount).ToImmutableArray()
            )
        }
        return FormatType(containingType)
    }

    private func FormatTypeArguments(typeArguments ImmutableArray[TypeSymbol]) string {
        return if typeArguments.IsDefaultOrEmpty {
            string.Empty
        } else {
            "[${string.Join(", ", typeArguments.Select(FormatType))}]"
        }
    }

    private func GetDisplayTypeArguments(
        typeArguments ImmutableArray[TypeSymbol],
        typeParameters ImmutableArray[TypeParameterSymbol]
    ) ImmutableArray[TypeSymbol] {
        return if !typeArguments.IsDefaultOrEmpty {
            typeArguments
        } else {
            typeParameters.Cast[TypeSymbol]().ToImmutableArray()
        }
    }

    /// Renders a (cref:FunctionTypeSymbol) in its canonical arrow shape
    /// `(P1, P2, ...) -> R` (ADR-0075 / issue #715), recursing through
    /// (cref:FormatType) so nested imported/wrapper element types render
    /// consistently. A trailing variadic parameter is rendered with the
    /// `...` prefix and its element type (ADR-0102 follow-up / issue #818),
    /// and a void return renders as `void`.
    private func FormatFunctionType(function FunctionTypeSymbol) string {
        let hasVariadicFlags = !function.IsVariadic.IsDefaultOrEmpty
        let sb = StringBuilder()
        sb.Append('(')
        for var i = 0; i < function.ParameterTypes.Length; i++ {
            if i > 0 {
                sb.Append(", ")
            }
            if (hasVariadicFlags && function.IsVariadic[i]) {
                sb.Append("...")
                sb.Append(
                    if function.ParameterTypes[i] is SliceTypeSymbol slice {
                        FormatType(slice.ElementType)
                    } else {
                        FormatType(function.ParameterTypes[i])
                    }
                )
            } else {
                sb.Append(FormatType(function.ParameterTypes[i]))
            }
        }
        sb.Append(") -> ")
        sb.Append(FormatType(function.ReturnType))
        return sb.ToString()
    }

    private func FormatFunctionPointerType(functionPointer FunctionPointerTypeSymbol) string {
        let parameters = string.Join(", ", functionPointer.ParameterTypes.Select(FormatGenericTypeArgument))
        let returnType = FormatGenericTypeArgument(functionPointer.ReturnType)
        if !functionPointer.IsManaged {
            // ADR-0095 v2 / issue #3611: the open model renders the source
            // spelling — bare `unmanaged (…)` for the platform default,
            // `unmanaged[A, B] (…)` for a convention list.
            if functionPointer.IsUnmanagedExtended {
                let slot = if functionPointer.UnmanagedConventions.IsDefaultOrEmpty {
                    string.Empty
                } else {
                    "[${string.Join(", ", functionPointer.UnmanagedConventions)}]"
                }
                return "unmanaged$slot ($parameters) -> $returnType"
            }
            return "unmanaged[${functionPointer.CallingConvention}] ($parameters) -> $returnType"
        }
        return if functionPointer.ReturnType == TypeSymbol.Void {
            "*func($parameters)"
        } else {
            "*func($parameters) $returnType"
        }
    }

    /// Renders an (cref:ImportedTypeSymbol) with a friendly, G#-flavored
    /// name. A plain imported type is formatted from its CLR (cref:Type)
    /// (so constructed generics become `Outer[Arg]` and primitives map to
    /// their G# spellings). A #313 symbolic construction — whose CLR form is
    /// type-erased to `object` — is rebuilt from its open definition plus
    /// the symbolic (cref:ImportedTypeSymbol.TypeArguments).
    private func FormatImportedType(imported ImportedTypeSymbol) string {
        if !imported.TypeArguments.IsDefaultOrEmpty {
            let definition Type? = imported.OpenDefinition
            return if definition == nil {
                "${StripGenericArity(imported.Name)}[${string.Join(", ", imported.TypeArguments.Select(FormatGenericTypeArgument))}]"
            } else {
                FormatImportedGenericTypeName(definition, imported.TypeArguments)
            }
        }
        return FormatClrTypeName(imported.ClrType, qualifyNames: true)
    }

    /// Strips the CLR generic-arity suffix (``1`) and normalizes nested
    /// type separators (`+` to `.`) from a reflected type name.
    private func StripGenericArity(name string) string {
        var name = name
        if string.IsNullOrEmpty(name) {
            return name
        }
        for var tickIndex = name.IndexOf('`'); tickIndex >= 0; tickIndex = name.IndexOf('`', tickIndex) {
            var endIndex = tickIndex + 1
            while endIndex < name.Length && char.IsDigit(name[endIndex]) {
                endIndex++
            }
            name = name.Remove(tickIndex, endIndex - tickIndex)
        }
        return name.Replace('+', '.')
    }

    private func FormatClrMemberName(declaringType Type?, name string?, format SymbolDisplayFormat) string {
        return if format.QualifyNames && declaringType != nil {
            "${FormatClrTypeName(declaringType, qualifyNames: true)}.$name"
        } else {
            name ?? string.Empty
        }
    }

    private func FormatClrTypeName(clrType Type?, qualifyNames bool) string {
        if ByteStringTypes.IsDefinition(clrType) {
            return "bytestring"
        }
        if ManagedReferenceTypes.IsDefinition(clrType, out var readOnlyManaged) {
            return "${(if readOnlyManaged { "readonly " } else { string.Empty })}managed[${FormatClrTypeName(clrType.GetGenericArguments()[0], qualifyNames)}]"
        }
        if NativeSliceTypes.IsDefinition(clrType, out var readOnlySlice) {
            return "${(if readOnlySlice { "readonly " } else { string.Empty })}slice[${FormatClrTypeName(clrType.GetGenericArguments()[0], qualifyNames)}]"
        }
        if clrType == nil {
            return "void"
        }
        if clrType.IsSameAs(typeof(Void)) {
            return "void"
        }
        // Map CLR primitives to G# type names.
        if TryGetGSharpPrimitiveName(clrType, out var primitiveName) {
            return primitiveName
        }
        if clrType.IsByRef {
            return "${FormatClrTypeName(clrType.GetElementType(), qualifyNames)}@"
        }
        if clrType.IsArray {
            return if clrType.GetArrayRank() == 1 {
                "[]${FormatClrTypeName(clrType.GetElementType(), qualifyNames)}"
            } else {
                "[${String(',', clrType.GetArrayRank() - 1)}]${FormatClrTypeName(clrType.GetElementType(), qualifyNames)}"
            }
        }
        if clrType.IsPointer {
            return "${FormatClrTypeName(clrType.GetElementType(), qualifyNames)}*"
        }
        if clrType.IsGenericParameter {
            return clrType.Name
        }
        if !clrType.IsGenericType {
            return if qualifyNames {
                (clrType.FullName ?? clrType.Name).Replace('+', '.')
            } else {
                clrType.Name
            }
        }
        return FormatClrGenericTypeName(clrType.GetGenericTypeDefinition(), clrType.GetGenericArguments(), qualifyNames)
    }

    private func FormatClrGenericTypeName(definition Type?, typeArguments[]Type, qualifyNames bool) string {
        if definition == nil {
            return string.Empty
        }
        let declaringArgumentCount = definition.DeclaringType?.GetGenericArguments().Length ?? 0
        let ownArguments = typeArguments.Skip(declaringArgumentCount).ToArray()
        var name = StripGenericArity(definition.Name)
        if definition.IsNested {
            let declaringArguments = typeArguments.Take(declaringArgumentCount).ToArray()
            name = "${FormatClrGenericTypeName(definition.DeclaringType, declaringArguments, qualifyNames)}.$name"
        } else if qualifyNames && !string.IsNullOrEmpty(definition.Namespace) {
            name = "${definition.Namespace}.$name"
        }
        return if ownArguments.Length == 0 {
            name
        } else {
            "$name[${FormatClrTypeArguments(ownArguments, qualifyNames)}]"
        }
    }

    private func FormatImportedGenericTypeName(definition Type, typeArguments ImmutableArray[TypeSymbol]) string {
        let declaringArgumentCount = definition.DeclaringType?.GetGenericArguments().Length ?? 0
        let ownArguments = typeArguments.Skip(declaringArgumentCount).ToImmutableArray()
        var name = StripGenericArity(definition.Name)
        if definition.IsNested {
            // A nested type always has a declaring type.
            name = "${FormatImportedGenericTypeName(definition.DeclaringType!!, typeArguments.Take(declaringArgumentCount).ToImmutableArray())}.$name"
        } else if !string.IsNullOrEmpty(definition.Namespace) {
            name = "${definition.Namespace}.$name"
        }
        return if ownArguments.IsDefaultOrEmpty {
            name
        } else {
            "$name[${string.Join(", ", ownArguments.Select(FormatGenericTypeArgument))}]"
        }
    }

    private func FormatGenericTypeArgument(type TypeSymbol?) string -> if type == nil {
        "?"
    } else {
        FormatType(type)
    }

    private func FormatClrTypeArguments(arguments[]Type, qualifyNames bool) string {
        let formatted = [arguments.Length]string
        for var i = 0; i < arguments.Length; i++ {
            formatted[i] = FormatClrTypeName(arguments[i], qualifyNames)
        }
        return string.Join(", ", formatted)
    }

    private func TryGetGSharpPrimitiveName(clrType Type, @NotNullWhen(true) out name string?) bool {
        if clrType.IsSameAs(typeof(bool)) {
            name = "bool"
            return true
        }
        if clrType.IsSameAs(typeof(uint8)) {
            name = "uint8"
            return true
        }
        if clrType.IsSameAs(typeof(int8)) {
            name = "int8"
            return true
        }
        if clrType.IsSameAs(typeof(int16)) {
            name = "int16"
            return true
        }
        if clrType.IsSameAs(typeof(uint16)) {
            name = "uint16"
            return true
        }
        if clrType.IsSameAs(typeof(int32)) {
            name = "int32"
            return true
        }
        if clrType.IsSameAs(typeof(uint32)) {
            name = "uint32"
            return true
        }
        if clrType.IsSameAs(typeof(int64)) {
            name = "int64"
            return true
        }
        if clrType.IsSameAs(typeof(uint64)) {
            name = "uint64"
            return true
        }
        if clrType.IsSameAs(typeof(nint)) {
            name = "nint"
            return true
        }
        if clrType.IsSameAs(typeof(nuint)) {
            name = "nuint"
            return true
        }
        if clrType.IsSameAs(typeof(float32)) {
            name = "float32"
            return true
        }
        if clrType.IsSameAs(typeof(float64)) {
            name = "float64"
            return true
        }
        if clrType.IsSameAs(typeof(decimal)) {
            name = "decimal"
            return true
        }
        if clrType.IsSameAs(typeof(char)) {
            name = "char"
            return true
        }
        if clrType.IsSameAs(typeof(string)) {
            name = "string"
            return true
        }
        if clrType.IsSameAs(typeof(object)) {
            name = "object"
            return true
        }
        name = nil
        return false
    }

    private func IsByRefLikeType(type Type) bool {
        // System.Runtime.CompilerServices.IsByRefLikeAttribute is present on ref structs.
        // Use GetCustomAttributesData (metadata-only) rather than GetCustomAttributes
        // (which instantiates attribute objects). The latter throws under a
        // MetadataLoadContext — the LSP loads references that way so it sees
        // target-framework-bound assemblies (see ReferenceResolver.WithReferences).
        if !type.IsValueType {
            return false
        }
        try {
            for attr in type.GetCustomAttributesData() {
                if attr.AttributeType?.FullName == "System.Runtime.CompilerServices.IsByRefLikeAttribute" {
                    return true
                }
            }
        } catch (Exception) {
            // Some loaders/assemblies can throw when enumerating metadata; degrade gracefully.

        }
        return false
    }

    private func IsVoid(type TypeSymbol?) bool {
        return type == nil || object.ReferenceEquals(type, TypeSymbol.Void)
    }

    private func ResolveVariableKeyword(variable VariableSymbol, compilation Compilation?) string {
        if compilation != nil && variable.DeclaringSyntax is SyntaxToken identifier {
            for tree in compilation.SyntaxTrees {
                for declaration in FindVariableDeclarations(tree.Root) {
                    if object.ReferenceEquals(declaration.Identifier, identifier) ||
                        (
                        declaration
                            .Identifier
                            .Span
                            .Start == identifier
                            .Span
                            .Start &&
                            declaration
                            .Identifier
                            .Span
                            .Length == identifier
                            .Span
                            .Length &&
                            declaration
                            .Identifier
                            .ValueText == identifier.ValueText
                    ) {
                        let keyword = declaration.Keyword?.Text
                        if !string.IsNullOrEmpty(keyword) {
                            return keyword
                        }
                    }
                }
            }
        }
        return if variable.IsReadOnly {
            "let"
        } else {
            "var"
        }
    }

    private func FindVariableDeclarations(node SyntaxNode) sequence[VariableDeclarationSyntax] {
        if node is VariableDeclarationSyntax declaration {
            yield declaration
        }
        for child in node.GetChildren() {
            for descendant in FindVariableDeclarations(child) {
                yield descendant
            }
        }
    }

    private func PartsToString(parts ImmutableArray[SymbolDisplayPart]) string {
        return string.Concat(parts.Select((p SymbolDisplayPart) -> p.Text))
    }
}
