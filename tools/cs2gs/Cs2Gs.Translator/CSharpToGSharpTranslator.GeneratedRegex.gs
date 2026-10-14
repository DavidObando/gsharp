// <copyright file="CSharpToGSharpTranslator.GeneratedRegex.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import System.Collections.Generic
import System.Linq

/// Issue #4301 (ADR-0192 follow-on 3): C# `[GeneratedRegex]` partial
/// methods.
/// @remarks A C# `[GeneratedRegex]` method is a partial DEFINITION whose
/// implementation the Regex source generator writes. G# spells the same thing
/// natively: a body-less `@GeneratedRegex(...) partial func F() Regex;`
/// declaring part (ADR-0192), whose implementing part gsgen produces at build
/// time by running the same generator (ADR-0145, ADR-0192 follow-on 2). So
/// the definition translates to exactly that declaring part, in the type's
/// `shared` block when it is static, and the generated C#
/// implementation is dropped like any other generator output.
///
/// The attribute's arguments are re-spelled from their bound constant
/// values, positionally in constructor order (the attribute has no settable
/// properties), so a `const` pattern or a named
/// `matchTimeoutMilliseconds:` argument reaches gsgen as the literal the
/// generator needs, and the same constructor overload binds.
///
/// Shapes G# cannot pair with a generated implementing part are
/// reported, never rewritten: an interface or inline-struct owner (GS0607),
/// the legacy merge mode's non-partial type (GS0608), and a nested owner
/// (gsgen's stub renders only top-level types, so no implementing part is
/// generated, GS0609).
///
/// An entry class declaring one is kept as a class rather than hoisted
/// to top-level funcs, which cannot be partial.
partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private let regexGeneratorImplementationStates Dictionary[
            SyntaxTree,
            (Retained bool, Regenerated bool)
        ] = Dictionary[SyntaxTree, (Retained bool, Regenerated bool)]()
        private let reportedMixedRegexGeneratorTrees HashSet[SyntaxTree] = HashSet[SyntaxTree]()

        private func GetRegexGeneratorImplementationState(tree SyntaxTree?)(Retained bool, Regenerated bool) {
            if this.regexGeneratorImplementationStates.TryGetValue(tree!!, out var cached) {
                return cached
            }
            var retained = false
            var regenerated = false
            for node in tree!!.GetRoot().DescendantNodes().OfType[MemberDeclarationSyntax]() {
                let implementation ISymbol? = this.context.GetDeclaredSymbol(node)
                if !CSharpToGSharpTranslator.IsRegexGeneratorDeclaration(implementation) {
                    continue
                }
                let definition ISymbol? = switch implementation {
                    case IMethodSymbol{
                        PartialDefinitionPart: IMethodSymbol method
                    } when CSharpToGSharpTranslator.IsGeneratedRegexDefinition(method): cast[ISymbol](method)
                    case IPropertySymbol{
                        PartialDefinitionPart: IPropertySymbol property
                    } when CSharpToGSharpTranslator.HasAttribute(
                        property,
                        CSharpToGSharpTranslator.GeneratedRegexAttributeName
                    ): cast[ISymbol](property)
                    default: nil
                }
                if definition == nil {
                    continue
                }
                let definitionIsTranslated = definition.DeclaringSyntaxReferences.Any(
                    (reference SyntaxReference) -> this.IsTranslatedByThisRun(reference.SyntaxTree)
                )
                regenerated |= definitionIsTranslated
                retained |= !definitionIsTranslated
                if retained && regenerated {
                    break
                }
            }
            let state = (retained, regenerated)
            this.regexGeneratorImplementationStates.Add(tree!!, state)
            return state
        }

        /// Translates a C# `[GeneratedRegex]` partial definition to a G#
        /// declaring part (`@GeneratedRegex(...) partial func F() Regex;`),
        /// or reports the shapes G# cannot pair with gsgen's implementing part.
        /// @param node The definition's declaration.
        /// @param ownerKind The G# kind of the containing type.
        /// @param symbol The definition's symbol.
        /// @returns The translated member and whether it is static.
        private func TranslateGeneratedRegexDefinition(
            node MethodDeclarationSyntax,
            ownerKind TypeDeclarationKind,
            symbol IMethodSymbol
        )(Member GMember?, IsStatic bool) {
            var problem string? = nil
            if !this.preservePartialParts {
                problem = "its type is merged into one non-partial G# type in this mode, which cannot hold a " +
                    "partial func (GS0608)"
            } else if !CanDeclarePartialFunction(ownerKind) {
                problem = "its type translates to a G# " +
                    DescribeOwnerKind(ownerKind) +
                    ", which cannot " +
                    "declare a partial func (GS0607); only a class, struct, data class or data struct can"
            } else if symbol.ContainingType?.ContainingType != nil {
                problem = "its type is nested, and gsgen generates implementing parts only for top-level types " +
                    "(the declaring part would have no implementation, GS0609); move the method to a " +
                    "top-level partial type"
            }
            if problem != nil {
                let message = "[GeneratedRegex] method '${symbol.ContainingType?.Name}.${symbol.Name}' has no G# " +
                    "declaring-part form: $problem. The method is omitted, so every use of it fails to compile."
                this.context.ReportUnsupported(node, message)
                return (nil, false)
            }
            return this.TranslateMethod(node, ownerKind, isGeneratedRegexDefinition: true)
        }

        /// Maps the method-level attributes of a `[GeneratedRegex]`
        /// definition, re-spelling the `@GeneratedRegex` arguments from
        /// their bound constant values: positional, in constructor order.
        /// @param node The definition's declaration.
        /// @param symbol The definition's symbol.
        /// @returns The mapped attributes.
        private func MapGeneratedRegexMethodAttributes(node MethodDeclarationSyntax, symbol IMethodSymbol?) List[
            AttributeUse
        ] {
            let mappedTypes = List[INamedTypeSymbol]()
            let mapped = this.MapAttributesWithTypes(node.AttributeLists, mappedTypes)
            let data AttributeData? = CSharpToGSharpTranslator.FindGeneratedRegexAttribute(symbol)
            let result = List[AttributeUse](mapped.Count)
            for var index = 0; index < mapped.Count; index++ {
                let attribute = mapped[index]
                let methodTarget = attribute.Target == nil || attribute.Target == "method"
                if data == nil || !methodTarget || !this.IsWellKnownAttribute(
                    mappedTypes[index],
                    CSharpToGSharpTranslator.GeneratedRegexAttributeName
                ) {
                    result.Add(attribute)
                    continue
                }
                let arguments = List[AttributeArgument](data.ConstructorArguments.Length)
                for argument in data.ConstructorArguments {
                    let value GExpression? = if argument.Value == nil {
                        cast[GExpression](LiteralExpression.Null())
                    } else {
                        this.MapConstantValue(argument.Value, argument.Type, node, "GeneratedRegex argument")
                    }
                    if value == nil {
                        // Not a constant G# can spell as a literal (the
                        // constructor takes only string, RegexOptions and
                        // int): keep the ordinary attribute translation.
                        return mapped
                    }
                    arguments.Add(AttributeArgument(value))
                }
                result.Add(AttributeUse(attribute.Name, arguments, nil))
            }
            return result
        }

        shared {
            private func DescribeOwnerKind(ownerKind TypeDeclarationKind) string -> switch ownerKind {
                case TypeDeclarationKind.DataClass: "data class (a C# record)"
                case TypeDeclarationKind.DataStruct: "data struct (a C# record struct)"
                case TypeDeclarationKind.InlineStruct: "inline struct"
                case TypeDeclarationKind.Interface: "interface"
                default: ownerKind.ToString()
            }
        }
    }

    shared {
        private const GeneratedRegexAttributeName string = "System.Text.RegularExpressions.GeneratedRegexAttribute"
        private const RegexGeneratorName string = "System.Text.RegularExpressions.Generator"

        /// Whether [`method`](paramref) is the definition part of a C#
        /// `[GeneratedRegex]` partial method (identified by the attribute's
        /// resolved type).
        /// @param method The method symbol (any part).
        /// @returns `true` for a `[GeneratedRegex]` partial definition.
        private func IsGeneratedRegexDefinition(method IMethodSymbol?) bool -> method != nil &&
            method.IsPartialDefinition &&
            FindGeneratedRegexAttribute(method) != nil

        private func FindGeneratedRegexAttribute(method IMethodSymbol?) AttributeData? -> method!!.GetAttributes()
            .FirstOrDefault((attribute AttributeData) -> IsAttributeOfType(attribute, GeneratedRegexAttributeName))

        private func IsRegexGeneratorDeclaration(symbol ISymbol?) bool -> symbol?.GetAttributes().Any(
            (attribute AttributeData) -> attribute
                .AttributeClass
                ?.ToDisplayString() == "System.CodeDom.Compiler.GeneratedCodeAttribute" &&
                attribute
                .ConstructorArguments
                .Length > 0 &&
                attribute
                .ConstructorArguments[0]
                .Value is string generator &&
                generator == RegexGeneratorName
        ) == true

        /// Whether [`type`](paramref) declares a `[GeneratedRegex]`
        /// partial method. Such an entry class keeps its type rather than being
        /// hoisted to top-level funcs, which cannot be partial.
        /// @param type The type to inspect.
        /// @returns `true` when any member is a `[GeneratedRegex]` definition.
        private func DeclaresGeneratedRegexDefinition(type INamedTypeSymbol?) bool -> type!!.GetMembers().Any(
            (member ISymbol) -> member is IMethodSymbol method && IsGeneratedRegexDefinition(method)
        )
    }
}
