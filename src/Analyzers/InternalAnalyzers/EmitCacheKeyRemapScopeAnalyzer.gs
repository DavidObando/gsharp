// <copyright file="EmitCacheKeyRemapScopeAnalyzer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable

/// GSA0004 (issue #3163): enforces the Emit cache-key invariant — every
/// dictionary in `GSharp.Core.CodeAnalysis.Emit` that maps symbols to
/// scope-sensitive metadata rows (TypeSpec / MemberRef / MethodSpec /
/// EntityHandle) must include the generic-remap scope (`RemapScope`)
/// in its key.
/// @remarks The same symbol encodes to different `VAR`/`MVAR` ordinals
/// depending on the remaps active on `GenericRemapState`, so a cache
/// key that omits the scope reuses a row whose signature blob encodes the
/// other scope's ordinals — an invalid assembly discovered only at runtime
/// (`BadImageFormatException`). This bug class shipped as #2930/#3057
/// (constructor MemberRefs) and again as #3065 (MethodSpecs); this rule
/// makes a third recurrence a build break instead of a runtime defect.
///
/// Definition-handle caches (`TypeDefinitionHandle`,
/// `MethodDefinitionHandle`, `FieldDefinitionHandle`, ...) are
/// scope-invariant by construction — a symbol has exactly one definition row
/// — and are deliberately not flagged. Caches keyed purely on CLR
/// reflection objects (`Type`, `MethodInfo`, ...) carry no
/// symbolic type parameters and are likewise exempt.
@GSharpDiagnosticAnalyzer
class EmitCacheKeyRemapScopeAnalyzer : GSharpDiagnosticAnalyzer {
    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    private var _supportedDiagnostics ImmutableArray[DiagnosticDescriptor] = ImmutableArray.Create(
        DiagnosticDescriptors.EmitCacheKeyMissingRemapScope
    )

    override prop SupportedDiagnostics ImmutableArray[DiagnosticDescriptor] -> _supportedDiagnostics

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Initialize(context AnalysisContext) {
        context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None)
        context.EnableConcurrentExecution()
        context.RegisterSymbolAction(AnalyzeField, SymbolKind.Field)
        context.RegisterSymbolAction(AnalyzeProperty, SymbolKind.Property)
    }

    shared {
        private const EmitNamespace string = "GSharp.Core.CodeAnalysis.Emit"
        private const SymbolsNamespace string = "GSharp.Core.CodeAnalysis.Symbols"
        private const RemapScopeTypeName string = "RemapScope"
        private const MaxDepth int32 = 6
        private let SensitiveHandleTypes ImmutableHashSet[string] = ImmutableHashSet.Create(
            "global::System.Reflection.Metadata.EntityHandle",
            "global::System.Reflection.Metadata.MemberReferenceHandle",
            "global::System.Reflection.Metadata.TypeSpecificationHandle",
            "global::System.Reflection.Metadata.MethodSpecificationHandle"
        )

        private func AnalyzeField(context SymbolAnalysisContext) {
            let field = cast[FieldSymbol](context.Symbol)
            if field.IsImplicitlyDeclared {
                return
            }
            AnalyzeCacheMember(context, field, field.Type, field.Name)
        }

        private func AnalyzeProperty(context SymbolAnalysisContext) {
            let property = cast[PropertySymbol](context.Symbol)
            AnalyzeCacheMember(context, property, property.Type, property.Name)
        }

        private func AnalyzeCacheMember(
            context SymbolAnalysisContext,
            member Symbol,
            memberType TypeSymbol,
            memberName string
        ) {
            if !IsEmitNamespace(member.ContainingNamespace) {
                return
            }
            if memberType is not TypeSymbol namedType ||
                namedType
                .ConstructedTypeArguments
                .Length != 2 ||
                !IsDictionary(namedType) {
                return
            }
            let keyType = namedType.ConstructedTypeArguments[0]
            let valueType = namedType.ConstructedTypeArguments[1]
            if !Mentions(valueType, IsSensitiveHandle) || !Mentions(keyType, IsGSharpSymbolType) {
                return
            }
            if Mentions(keyType, IsRemapScope) {
                return
            }
            context.ReportDiagnostic(
                Diagnostic.Create(DiagnosticDescriptors.EmitCacheKeyMissingRemapScope, member.Location, memberName)
            )
        }

        private func IsEmitNamespace(namespaceSymbol string?) bool {
            let name string? = namespaceSymbol
            return name == EmitNamespace ||
                (name != nil && name.StartsWith(EmitNamespace + ".", StringComparison.Ordinal))
        }

        private func IsDictionary(type TypeSymbol) bool {
            let metadataName = type.ConstructedFrom.ToDisplayString(DisplayFormat.FullyQualified)
            return metadataName == "global::System.Collections.Generic.Dictionary<TKey, TValue>" ||
                metadataName == "global::System.Collections.Concurrent.ConcurrentDictionary<TKey, TValue>"
        }

        private func IsSensitiveHandle(type TypeSymbol) bool -> SensitiveHandleTypes.Contains(
            type.ToDisplayString(DisplayFormat.FullyQualified)
        )

        private func IsGSharpSymbolType(type TypeSymbol) bool -> type.ContainingNamespace == SymbolsNamespace

        private func IsRemapScope(type TypeSymbol) bool -> type.Name == RemapScopeTypeName &&
            IsEmitNamespace(type.ContainingNamespace)

        /// Walks the structure of [`type`](paramref) — tuple elements,
        /// generic type arguments, and the instance fields of user-defined key
        /// structs declared in the Emit namespace — looking for any component
        /// matching [`predicate`](paramref).
        private func Mentions(type TypeSymbol, predicate(TypeSymbol) -> bool) bool -> Mentions(
            type,
            predicate,
            HashSet[TypeSymbol](SymbolEqualityComparer.Default),
            depth: 0
        )

        private func Mentions(
            type TypeSymbol?,
            predicate(TypeSymbol) -> bool,
            visited HashSet[TypeSymbol],
            depth int32
        ) bool {
            if type == nil || depth > MaxDepth || !visited.Add(type) {
                return false
            }
            if predicate(type) {
                return true
            }
            if type is SliceTypeSymbol arrayType {
                return Mentions(arrayType.ElementType, predicate, visited, depth + 1)
            }
            if type is not TypeSymbol namedType {
                return false
            }
            if namedType.IsTupleType {
                for element in namedType.TupleElements {
                    if Mentions(element.Type, predicate, visited, depth + 1) {
                        return true
                    }
                }
                return false
            }
            for typeArgument in namedType.ConstructedTypeArguments {
                if Mentions(typeArgument, predicate, visited, depth + 1) {
                    return true
                }
            }
            // A user-defined composite key struct (e.g. MethodSpecSymbolKey)
            // declared in the Emit namespace: inspect its instance fields so both
            // the symbol mention and the RemapScope requirement see through it.
            if namedType.IsValueType && IsEmitNamespace(namedType.ContainingNamespace) {
                for fieldMember in namedType.GetMembers() {
                    if fieldMember is FieldSymbol{IsStatic: false} instanceField &&
                        Mentions(instanceField.Type, predicate, visited, depth + 1) {
                        return true
                    }
                }
            }
            return false
        }
    }
}
