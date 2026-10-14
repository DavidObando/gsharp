// <copyright file="CSharpToGSharpTranslator.LibraryImport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.InteropServices

/// Issue #4370: C# `[LibraryImport]` partial methods, and the safety net
/// for any other partial member whose implementation a source generator
/// produces.
/// @remarks A `[LibraryImport]` method is a C# partial DEFINITION whose
/// implementation the LibraryImportGenerator writes. cs2gs never translates
/// generator output, and the G# SDK removes that generator from gsgen, so
/// the ordinary partial-method rule (skip the definition, translate the
/// implementation) used to drop the method entirely while its callers
/// survived — a translation that PASSed and then failed in gsc with GS0130.
/// gsc supports `@LibraryImport` natively (ADR-0092): a body-less
/// `@LibraryImport(...) func F(...) R;` is a complete declaration from
/// which gsc emits the marshalling stub and inner P/Invoke. So the
/// definition translates to exactly that, as a static member of its type
/// (`shared`), keeping its accessibility, parameters, ref kinds and
/// parameter/return attributes; the generated implementation is not
/// needed.
///
/// The `[LibraryImport]` surface gsc does not honour — a custom
/// string marshaller, `[MarshalUsing]`/`[NativeMarshalling]`
/// custom marshallers, an `[UnmanagedCallConv]` other than cdecl, and a return-value
/// `[MarshalAs]` other than `UnmanagedType.Bool` — would
/// otherwise compile with different marshalling, so each is reported as a
/// translation gap.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Maps [`attributeLists`](paramref) exactly as
        /// `MapAttributes` does and records, for each mapped attribute,
        /// the attribute class it RESOLVES to in C# (null when unresolved).
        /// P/Invoke rewrites decide by that type, never by the rendered name,
        /// which an alias (`using MA = ...MarshalAsAttribute;`) or an
        /// unrelated same-named attribute would fool.
        /// @param attributeLists The C# attribute lists.
        /// @param resolvedTypes Receives one entry per returned attribute.
        /// @returns The mapped attributes.
        private func MapAttributesWithTypes(
            attributeLists IEnumerable[AttributeListSyntax],
            resolvedTypes List[INamedTypeSymbol]
        ) List[AttributeUse] {
            let mapped = List[AttributeUse]()
            for list in attributeLists {
                let listMapped = this.MapAttributes([]AttributeListSyntax{list})
                let listTypes = List[INamedTypeSymbol]()
                for attribute in list.Attributes {
                    using let modelScope = this.context.UseSemanticModelFor(attribute.SyntaxTree)
                    this.ResolveAttributeType(attribute, out var attributeType, out _)
                    listTypes.Add(attributeType!!)
                }
                for var i = 0; i < listMapped.Count; i++ {
                    mapped.Add(listMapped[i])
                    resolvedTypes.Add(
                        if listMapped.Count == listTypes.Count {
                            listTypes[i]
                        } else {
                            default(INamedTypeSymbol?)
                        }
                    )
                }
            }
            return mapped
        }

        private func IsWellKnownAttribute(attributeType INamedTypeSymbol?, metadataName string) bool {
            let wellKnown INamedTypeSymbol? = this.context.Compilation.GetTypeByMetadataName(metadataName)
            return attributeType != nil && wellKnown != nil && SymbolEqualityComparer.Default.Equals(
                attributeType.OriginalDefinition,
                wellKnown
            )
        }

        /// Issue #4370: a `[LibraryImport]` string parameter's attributes
        /// without its `[MarshalAs]` (identified by type), which
        /// `MapLibraryImportMethodAttributes` folds into the import's
        /// `StringMarshalling` — gsc rejects a string `@MarshalAs`
        /// under `@LibraryImport` (GS0360).
        /// @param attributeLists The parameter's attribute lists.
        /// @returns The mapped attributes, `[MarshalAs]` removed.
        private func MapAttributesWithoutMarshalAs(attributeLists IEnumerable[AttributeListSyntax]) List[AttributeUse] {
            let types = List[INamedTypeSymbol]()
            let mapped = this.MapAttributesWithTypes(attributeLists, types)
            let result = List[AttributeUse](mapped.Count)
            for var i = 0; i < mapped.Count; i++ {
                if !this.IsWellKnownAttribute(types[i], CSharpToGSharpTranslator.MarshalAsAttributeName) {
                    result.Add(mapped[i])
                }
            }
            return result
        }

        /// Translates a C# `[LibraryImport]` partial definition to the
        /// native body-less G# `@LibraryImport` declaration, after
        /// reporting every part of its marshalling surface gsc would not
        /// honour.
        /// @param node The definition's declaration.
        /// @param ownerKind The G# kind of the containing type.
        /// @param symbol The definition's symbol.
        /// @returns The translated member and whether it is static.
        private func TranslateLibraryImportDefinition(
            node MethodDeclarationSyntax,
            ownerKind TypeDeclarationKind,
            symbol IMethodSymbol
        )(Member GMember?, IsStatic bool) {
            this.ReportUnsupportedLibraryImportSurface(node, symbol)
            return this.TranslateMethod(node, ownerKind, isNativeImportDefinition: true)
        }

        /// Maps the method-level attributes of a `[LibraryImport]`
        /// definition. The `@LibraryImport` arguments gsc reads (the
        /// library name, `EntryPoint`, `SetLastError`,
        /// `StringMarshalling`) are re-spelled from their compile-time
        /// constant values, so a library name written as a `const`
        /// (`[LibraryImport(NativeLibName)]`) reaches gsc as the string
        /// literal its P/Invoke binder requires.
        /// @param node The definition's declaration.
        /// @param symbol The definition's symbol.
        /// @returns The mapped attributes.
        private func MapLibraryImportMethodAttributes(node MethodDeclarationSyntax, symbol IMethodSymbol?) List[
            AttributeUse
        ] {
            let mappedTypes = List[INamedTypeSymbol]()
            let mapped = this.MapAttributesWithTypes(node.AttributeLists, mappedTypes)
            let data AttributeData? = CSharpToGSharpTranslator.FindLibraryImportAttribute(symbol)
            if data == nil {
                return mapped
            }
            // A per-string [MarshalAs(LPUTF8Str/LPWStr)] becomes the import's
            // StringMarshalling (gsc has no per-string encoding).
            let foldedEncoding = CSharpToGSharpTranslator.ResolveLibraryImportStringMarshalling(
                symbol,
                out var usesMarshalAs,
                out _
            )
            let foldedStringMarshalling GExpression? = if usesMarshalAs && foldedEncoding != 0 {
                this.MapConstantValue(
                    foldedEncoding,
                    this.context.Compilation.GetTypeByMetadataName("System.Runtime.InteropServices.StringMarshalling"),
                    node,
                    "LibraryImport StringMarshalling"
                )
            } else {
                default(GExpression?)
            }
            let stringReturn = symbol!!.ReturnType.SpecialType == SpecialType.System_String
            let result = List[AttributeUse](mapped.Count)
            for var index = 0; index < mapped.Count; index++ {
                let attribute = mapped[index]
                let attributeType = mappedTypes[index]
                if attribute.Target == "return" && stringReturn && this.IsWellKnownAttribute(
                    attributeType,
                    CSharpToGSharpTranslator.MarshalAsAttributeName
                ) {
                    continue
                }
                // `[method: LibraryImport(...)]` is the default target spelled
                // out; it gets the same argument rewrite, and the redundant
                // target is dropped.
                let methodTarget = attribute.Target == nil || attribute.Target == "method"
                if !methodTarget || !this.IsWellKnownAttribute(
                    attributeType,
                    CSharpToGSharpTranslator.LibraryImportAttributeName
                ) {
                    result.Add(attribute)
                    continue
                }
                let arguments = List[AttributeArgument](attribute.Arguments.Count)
                var hasStringMarshalling = false
                for argument in attribute.Arguments {
                    // LibraryImport constructor arguments are normalized to
                    // positional form after Roslyn has selected the overload.
                    let constructorIndex = ConstructorParameterIndex(data, argument.Name)
                    let emittedName string? = if constructorIndex >= 0 {
                        default(string?)
                    } else {
                        argument.Name
                    }
                    let isMemberAssignment = constructorIndex < 0 && argument.IsMemberAssignment
                    let constant GExpression? = if constructorIndex >= 0 {
                        MapConstructorArgumentConstant(data, constructorIndex)
                    } else {
                        (
                            if argument.Name == "StringMarshalling" && foldedStringMarshalling != nil {
                                foldedStringMarshalling
                            } else {
                                this.MapLibraryImportArgumentConstant(data, argument.Name, node)
                            }
                        )
                    }
                    hasStringMarshalling |= argument.Name == "StringMarshalling"
                    arguments.Add(
                        if constant == nil {
                            AttributeArgument(argument.Value, emittedName, isMemberAssignment)
                        } else {
                            AttributeArgument(constant, emittedName, isMemberAssignment)
                        }
                    )
                }
                if !hasStringMarshalling && foldedStringMarshalling != nil {
                    arguments.Add(
                        AttributeArgument(foldedStringMarshalling, "StringMarshalling", isMemberAssignment: true)
                    )
                }
                result.Add(AttributeUse(attribute.Name, arguments, nil))
            }
            return result
        }

        private func MapLibraryImportArgumentConstant(data AttributeData, name string?, node SyntaxNode) GExpression? {
            if name == nil {
                return MapConstructorArgumentConstant(data, 0)
            }
            if name != "EntryPoint" && name != "SetLastError" && name != "StringMarshalling" {
                return nil
            }
            for named in data.NamedArguments {
                if named.Key == name && named.Value.Kind != TypedConstantKind.Error && named.Value.Value != nil {
                    return this.MapConstantValue(named.Value.Value, named.Value.Type, node, "LibraryImport " + name)
                }
            }
            return nil
        }

        private func ReportUnsupportedLibraryImportSurface(node MethodDeclarationSyntax, symbol IMethodSymbol) {
            let name = symbol.Name
            let data AttributeData? = CSharpToGSharpTranslator.FindLibraryImportAttribute(symbol)
            if data != nil && data.NamedArguments.Any(
                (named KeyValuePair[string, TypedConstant]) -> named.Key == "StringMarshallingCustomType" &&
                    named
                    .Value
                    .Value != nil
            ) {
                let message = "[LibraryImport] method '$name' names a StringMarshallingCustomType; gsc's native " +
                    "@LibraryImport accepts the argument but runs no custom string marshaller (ADR-0092), " +
                    "so the translated import would marshal strings differently."
                this.context.ReportUnsupported(node, message)
            }
            this.ReportUnmanagedCallConv(node, symbol)
            CSharpToGSharpTranslator.ResolveLibraryImportStringMarshalling(symbol, out _, out var stringProblem)
            if stringProblem != nil {
                let stringMessage = "[LibraryImport] method '$name': $stringProblem."
                this.context.ReportUnsupported(node, stringMessage)
            }
            for parameter in symbol.Parameters {
                let subject = "parameter '${parameter.Name}' of [LibraryImport] method '$name'"
                this.ReportCustomMarshaller(node, subject, parameter.GetAttributes(), parameter.Type)
            }
            let returnSubject = "the return value of [LibraryImport] method '$name'"
            let returnAttributes = symbol.GetReturnTypeAttributes().ToList()
            this.ReportCustomMarshaller(node, returnSubject, returnAttributes, symbol.ReturnType)
            let returnMarshalAs AttributeData? = returnAttributes.FirstOrDefault(
                (attribute AttributeData) -> CSharpToGSharpTranslator.IsAttributeOfType(
                    attribute,
                    CSharpToGSharpTranslator.MarshalAsAttributeName
                )
            )
            if returnMarshalAs != nil &&
                symbol
                .ReturnType
                .SpecialType != SpecialType.System_String &&
                !(
                returnMarshalAs
                    .ConstructorArguments
                    .Length == 1 &&
                    returnMarshalAs
                    .ConstructorArguments[0]
                    .Value is int32 unmanagedType &&
                    unmanagedType == int32(UnmanagedType.Bool)
            ) {
                let message = "$returnSubject carries [return: MarshalAs] other than UnmanagedType.Bool; gsc applies " +
                    "no return-value MarshalAs to a P/Invoke (a 'bool' return always marshals as a 4-byte " +
                    "BOOL), so the translated import would read the native return differently."
                this.context.ReportUnsupported(node, message)
            }
            if symbol.ReturnType.SpecialType == SpecialType.System_String {
                let message = "[LibraryImport] method '$name' returns 'string'. The C# generator frees the returned " +
                    "native buffer with Marshal.FreeCoTaskMem; gsc's @LibraryImport treats it as non-owning and " +
                    "never frees it (ADR-0092). Check who owns the buffer: a caller-frees API now leaks."
                this.context.Report(
                    TranslationDiagnostic(
                        "MethodDeclaration",
                        message,
                        node.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = CSharpToGSharpTranslator.LibraryImportStringReturnDiagnosticId}
                )
            }
        }

        /// gsc's `@LibraryImport` always binds the inner P/Invoke with the
        /// platform-default calling convention and does not read
        /// `[UnmanagedCallConv]`. `CallConvCdecl` alone (the
        /// common shape — every Raylib-cs import carries it) is that default
        /// on every platform except 32-bit Windows, so it translates with a
        /// warning; any other calling convention or modifier is a gap.
        private func ReportUnmanagedCallConv(node MethodDeclarationSyntax, symbol IMethodSymbol) {
            let callConv AttributeData? = symbol.GetAttributes().FirstOrDefault(
                (attribute AttributeData) -> CSharpToGSharpTranslator.IsAttributeOfType(
                    attribute,
                    "System.Runtime.InteropServices.UnmanagedCallConvAttribute"
                )
            )
            if callConv == nil {
                return
            }
            // An omitted or empty `CallConvs` selects the platform default,
            // exactly what gsc's @LibraryImport uses, so it needs no warning.
            let hasCallConvs = callConv.NamedArguments.Any(
                (named KeyValuePair[string, TypedConstant]) -> named.Key == "CallConvs" &&
                    !(named.Value.Kind == TypedConstantKind.Array && named.Value.Values.IsDefaultOrEmpty)
            )
            if !hasCallConvs {
                return
            }
            let cdeclOnly = callConv.NamedArguments.All(
                (named KeyValuePair[string, TypedConstant]) -> named.Key == "CallConvs" &&
                    named
                    .Value
                    .Kind == TypedConstantKind.Array &&
                    named
                    .Value
                    .Values
                    .All(
                    (value TypedConstant) -> value.Value is ITypeSymbol type && type.ToDisplayString(
                        SymbolDisplayFormat.FullyQualifiedFormat
                    ) == "global::System.Runtime.CompilerServices.CallConvCdecl"
                )
            )
            if cdeclOnly {
                let warning = "[LibraryImport] method '${symbol.Name}' carries [UnmanagedCallConv(CallConvCdecl)]; gsc's " +
                    "@LibraryImport uses the platform-default calling convention, which is cdecl everywhere " +
                    "except 32-bit Windows (stdcall)."
                this.context.Report(
                    TranslationDiagnostic(
                        "MethodDeclaration",
                        warning,
                        node.GetLocation(),
                        TranslationSeverity.Warning
                    ){DiagnosticId = CSharpToGSharpTranslator.LibraryImportCallConvDiagnosticId}
                )
                return
            }
            let message = "[LibraryImport] method '${symbol.Name}' carries an [UnmanagedCallConv] other than " +
                "CallConvCdecl; gsc's native @LibraryImport always uses the platform-default calling " +
                "convention (ADR-0092) and would not apply it."
            this.context.ReportUnsupported(node, message)
        }

        private func ReportCustomMarshaller(
            node SyntaxNode,
            subject string,
            attributes IEnumerable[AttributeData],
            type ITypeSymbol
        ) {
            if attributes.Any(
                (attribute AttributeData) -> CSharpToGSharpTranslator.IsAttributeOfType(
                    attribute,
                    "System.Runtime.InteropServices.Marshalling.MarshalUsingAttribute"
                )
            ) {
                let message = "$subject carries [MarshalUsing]; gsc's native @LibraryImport has no custom marshallers " +
                    "(ADR-0092)."
                this.context.ReportUnsupported(node, message)
            }
            let marshalledType ITypeSymbol? = if type is IArrayTypeSymbol array {
                array.ElementType
            } else {
                type
            }
            if marshalledType != nil && marshalledType.GetAttributes().Any(
                (attribute AttributeData) -> CSharpToGSharpTranslator.IsAttributeOfType(
                    attribute,
                    "System.Runtime.InteropServices.Marshalling.NativeMarshallingAttribute"
                )
            ) {
                let message = "$subject has type '${marshalledType.Name}', which declares a [NativeMarshalling] custom " +
                    "marshaller; gsc's native @LibraryImport has no custom marshallers (ADR-0092)."
                this.context.ReportUnsupported(node, message)
            }
        }

        /// Whether this run emits [`tree`](paramref): membership in the
        /// caller's translated-file set when it supplied one (a repository
        /// migration translates git-tracked `<auto-generated>`
        /// files too), otherwise the loader's own generated-source rule.
        private func IsTranslatedByThisRun(tree SyntaxTree?) bool -> if this.translatedFilePaths != nil {
            this.translatedFilePaths.Contains(tree!!.FilePath)
        } else {
            this.IsHandAuthoredTranslatedTree(tree)
        }

        /// Issue #4370 safety net: reports a partial member whose definition
        /// this run translates but whose implementation is generated code
        /// that cs2gs does not translate (a source generator other than the
        /// ones whose definitions cs2gs translates itself —
        /// `[GeneratedRegex]` and `[LibraryImport]` partial
        /// methods, which never reach this report). The definition has no G# form without
        /// its implementation (a lone declaring part is GS0609), so the
        /// member is omitted; without this report the translation would
        /// PASS with the member silently missing and its callers failing in
        /// gsc.
        /// @param node The definition's declaration.
        /// @param definition The partial definition's symbol.
        /// @param implementation Its implementation part, if any.
        private func ReportGeneratedPartialImplementation(
            node MemberDeclarationSyntax,
            definition ISymbol?,
            implementation ISymbol?
        ) {
            let isGeneratedRegex = CSharpToGSharpTranslator.HasAttribute(
                definition,
                CSharpToGSharpTranslator.GeneratedRegexAttributeName
            )
            if !this.IsTranslatedByThisRun(node.SyntaxTree) {
                return
            }
            if isGeneratedRegex {
                let missingImplementationMessage = "partial member '${definition!!.ContainingType?.Name}.${definition!!.Name}' uses " +
                    "[GeneratedRegex], but G# has no partial properties (ADR-0192 §F); declare it as a " +
                    "[GeneratedRegex] partial METHOD, which cs2gs translates to a G# declaring part that " +
                    "gsgen implements."
                this.context.ReportUnsupported(node, missingImplementationMessage)
                return
            }
            if implementation == nil ||
                implementation
                .DeclaringSyntaxReferences
                .Length == 0 ||
                implementation
                .DeclaringSyntaxReferences
                .Any((reference SyntaxReference) -> this.IsTranslatedByThisRun(reference.SyntaxTree)) {
                return
            }
            let generatedFile = implementation.DeclaringSyntaxReferences[0].SyntaxTree.FilePath
            let remedy = if CSharpToGSharpTranslator.HasAttribute(
                definition,
                "CommunityToolkit.Mvvm.ComponentModel.ObservablePropertyAttribute"
            ) {
                "use the field form of [ObservableProperty], which gsgen regenerates for G#, or implement " +
                    "the property by hand in G#."
            } else {
                "cs2gs translates only [GeneratedRegex] and [LibraryImport] partial methods; implement this " +
                    "member by hand in G#."
            }
            let message = "partial member '${definition!!.ContainingType?.Name}.${definition!!.Name}' is implemented by " +
                "generated code ('$generatedFile') that cs2gs does not translate; the member is omitted from " +
                "the G# type, so every use of it fails to compile. " +
                remedy
            this.context.ReportUnsupported(node, message)
        }

        shared {
            /// The index of the attribute-constructor parameter a named argument
            /// (`libraryName: ...`) binds to, or -1 for a positional argument
            /// or a property assignment. Decided from the bound constructor's
            /// parameters, not the spelling alone: a property of the same name
            /// (the argument appears in (cref:AttributeData.NamedArguments))
            /// is not constructor-bound.
            private func ConstructorParameterIndex(data AttributeData, name string?) int32 {
                if name == nil || data.AttributeConstructor == nil || data.NamedArguments.Any(
                    (named KeyValuePair[string, TypedConstant]) -> named.Key == name
                ) {
                    return -1
                }
                let parameters = data.AttributeConstructor!!.Parameters
                for var i = 0; i < parameters.Length; i++ {
                    if parameters[i].Name == name {
                        return i
                    }
                }
                return -1
            }

            private func MapConstructorArgumentConstant(data AttributeData, index int32) GExpression? -> if index < data
                .ConstructorArguments
                .Length &&
                data
                .ConstructorArguments[index]
                .Value is string text {
                LiteralExpression.String(text)
            } else {
                default(LiteralExpression?)
            }
        }
    }

    shared {
        /// Issue #4370: warning id for a `[LibraryImport]` `string`
        /// return, whose native buffer C# frees but gsc treats as non-owning.
        /// Forwarded by the pipeline's Translate stage; never fails the app.
        const LibraryImportStringReturnDiagnosticId string = "CS2GS-LIBRARYIMPORT-STRING-RETURN"

        /// Issue #4370: warning id for a cdecl-only `[UnmanagedCallConv]`,
        /// which gsc's platform-default convention matches everywhere except
        /// 32-bit Windows. Forwarded by the pipeline; never fails the app.
        const LibraryImportCallConvDiagnosticId string = "CS2GS-LIBRARYIMPORT-CALLCONV"

        private const LibraryImportAttributeName string = "System.Runtime.InteropServices.LibraryImportAttribute"
        private const MarshalAsAttributeName string = "System.Runtime.InteropServices.MarshalAsAttribute"
        private func HasAttribute(symbol ISymbol?, attributeName string) bool -> symbol!!.GetAttributes().Any(
            (attribute AttributeData) -> IsAttributeOfType(attribute, attributeName)
        )

        // AttributeData carries the RESOLVED attribute class, so its fully
        // qualified name identifies the type independent of how the source spelled
        // it (an alias, or a same-named attribute in another namespace).
        private func IsAttributeOfType(attribute AttributeData, metadataName string) bool {
            let attributeClass INamedTypeSymbol? = attribute.AttributeClass
            return attributeClass != nil && attributeClass.TypeKind != TypeKind.Error && attributeClass.ToDisplayString(
                SymbolDisplayFormat.FullyQualifiedFormat
            ) == "global::" +
                metadataName
        }

        /// Whether [`method`](paramref) is the definition part of a C#
        /// `[LibraryImport]` partial method.
        /// @param method The method symbol (any part).
        /// @returns `true` for a `[LibraryImport]` partial definition.
        private func IsLibraryImportDefinition(method IMethodSymbol?) bool -> method != nil &&
            method.IsPartialDefinition &&
            FindLibraryImportAttribute(method) != nil

        private func FindLibraryImportAttribute(method IMethodSymbol?) AttributeData? -> method!!.GetAttributes()
            .FirstOrDefault((attribute AttributeData) -> IsAttributeOfType(attribute, LibraryImportAttributeName))

        /// The StringMarshalling (1 = Utf8, 2 = Utf16) every string parameter and
        /// a string return of [`method`](paramref) use, folding a per-string
        /// `[MarshalAs(LPUTF8Str)]` / `[MarshalAs(LPWStr)]` into it.
        /// gsc has no per-string encoding under `@LibraryImport` (GS0360),
        /// so a string `[MarshalAs]` it cannot express, or strings that
        /// disagree, set [`problem`](paramref).
        /// @param method The `[LibraryImport]` definition.
        /// @param usesMarshalAs Whether any string position carries `[MarshalAs]`.
        /// @param problem Why no single encoding exists, or `null`.
        /// @returns The shared encoding, or 0 when none is known.
        private func ResolveLibraryImportStringMarshalling(
            method IMethodSymbol?,
            out usesMarshalAs bool,
            out problem string?
        ) int32 {
            usesMarshalAs = false
            problem = nil
            var attributeEncoding = 0
            let libraryImport AttributeData? = FindLibraryImportAttribute(method)
            for named in libraryImport!!.NamedArguments {
                if named.Key == "StringMarshalling" && named.Value.Value is int32 value {
                    attributeEncoding = value
                }
            }
            let stringAttributes = List[IEnumerable[AttributeData]]()
            let stringPositions = List[string]()
            for parameter in method!!.Parameters {
                if parameter.Type.SpecialType == SpecialType.System_String {
                    stringAttributes.Add(parameter.GetAttributes())
                    stringPositions.Add("parameter '${parameter.Name}'")
                }
            }
            if method!!.ReturnType.SpecialType == SpecialType.System_String {
                stringAttributes.Add(method!!.GetReturnTypeAttributes())
                stringPositions.Add("the return value")
            }
            let encodings = HashSet[int32]()
            var hasUnresolvedString = false
            for var i = 0; i < stringAttributes.Count; i++ {
                let position = stringPositions[i]
                let marshalAs AttributeData? = stringAttributes[i].FirstOrDefault(
                    (attribute AttributeData) -> IsAttributeOfType(attribute, MarshalAsAttributeName)
                )
                if marshalAs == nil {
                    if attributeEncoding == 1 || attributeEncoding == 2 {
                        encodings.Add(attributeEncoding)
                    } else {
                        hasUnresolvedString = true
                    }
                    continue
                }
                usesMarshalAs = true
                let unmanagedType = if marshalAs
                    .ConstructorArguments
                    .Length == 1 &&
                    marshalAs
                    .ConstructorArguments[0]
                    .Value is int32 raw {
                    raw
                } else {
                    -1
                }
                if unmanagedType == int32(UnmanagedType.LPUTF8Str) {
                    encodings.Add(1)
                } else if unmanagedType == int32(UnmanagedType.LPWStr) {
                    encodings.Add(2)
                } else if problem == nil {
                    problem = "$position is a string with [MarshalAs(UnmanagedType." +
                        "${UnmanagedType(unmanagedType)})], which gsc's @LibraryImport " +
                        "cannot express (only UTF-8 and UTF-16 via StringMarshalling)"
                }
            }
            // A string with neither [MarshalAs] nor a method-wide Utf8/Utf16 has
            // no known encoding; folding a sibling's [MarshalAs] into the import
            // would silently change it.
            if problem == nil && usesMarshalAs && hasUnresolvedString {
                problem = "some strings carry [MarshalAs] and others have no encoding, but gsc applies one " +
                    "StringMarshalling to every string of an @LibraryImport"
            }
            if problem == nil && encodings.Count > 1 {
                problem = "its string parameters/return use different encodings, but gsc applies one " +
                    "StringMarshalling to every string of an @LibraryImport"
            }
            return if problem == nil && encodings.Count == 1 {
                encodings.First()
            } else {
                0
            }
        }
    }
}
