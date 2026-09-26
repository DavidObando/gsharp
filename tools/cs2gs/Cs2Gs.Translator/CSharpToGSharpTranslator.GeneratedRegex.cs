// <copyright file="CSharpToGSharpTranslator.GeneratedRegex.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #4301 (ADR-0192 follow-on 3): C# <c>[GeneratedRegex]</c> partial
/// methods.
/// </summary>
/// <remarks>
/// <para>A C# <c>[GeneratedRegex]</c> method is a partial DEFINITION whose
/// implementation the Regex source generator writes. G# spells the same thing
/// natively: a body-less <c>@GeneratedRegex(...) partial func F() Regex;</c>
/// declaring part (ADR-0192), whose implementing part gsgen produces at build
/// time by running the same generator (ADR-0145, ADR-0192 follow-on 2). So
/// the definition translates to exactly that declaring part, in the type's
/// <c>shared</c> block when it is static, and the generated C#
/// implementation is dropped like any other generator output.</para>
/// <para>The attribute's arguments are re-spelled from their bound constant
/// values, positionally in constructor order (the attribute has no settable
/// properties), so a <c>const</c> pattern or a named
/// <c>matchTimeoutMilliseconds:</c> argument reaches gsgen as the literal the
/// generator needs, and the same constructor overload binds.</para>
/// <para>Shapes G# cannot pair with a generated implementing part are
/// reported, never rewritten: a record or other non-class/struct owner
/// (GS0607), the legacy merge mode's non-partial type (GS0608), and a nested
/// owner (gsgen's stub renders only top-level types, so no implementing part
/// is generated, GS0609).</para>
/// <para>An entry class declaring one is kept as a class rather than hoisted
/// to top-level funcs, which cannot be partial (see
/// <see cref="IsMemberOfKeptTopLevelProgram"/> for the top-level-statements
/// <c>Program</c> class).</para>
/// </remarks>
public sealed partial class CSharpToGSharpTranslator
{
    private const string GeneratedRegexAttributeName = "System.Text.RegularExpressions.GeneratedRegexAttribute";

    /// <summary>
    /// Whether <paramref name="method"/> is the definition part of a C#
    /// <c>[GeneratedRegex]</c> partial method (identified by the attribute's
    /// resolved type).
    /// </summary>
    /// <param name="method">The method symbol (any part).</param>
    /// <returns><see langword="true"/> for a <c>[GeneratedRegex]</c> partial definition.</returns>
    private static bool IsGeneratedRegexDefinition(IMethodSymbol method) =>
        method != null
        && method.IsPartialDefinition
        && FindGeneratedRegexAttribute(method) != null;

    private static AttributeData FindGeneratedRegexAttribute(IMethodSymbol method) =>
        method.GetAttributes().FirstOrDefault(attribute =>
            IsAttributeOfType(attribute, GeneratedRegexAttributeName));

    /// <summary>
    /// Whether <paramref name="type"/> declares a <c>[GeneratedRegex]</c>
    /// partial method. Such an entry class keeps its type rather than being
    /// hoisted to top-level funcs, which cannot be partial.
    /// </summary>
    /// <param name="type">The type to inspect.</param>
    /// <returns><see langword="true"/> when any member is a <c>[GeneratedRegex]</c> definition.</returns>
    private static bool DeclaresGeneratedRegexDefinition(INamedTypeSymbol type) =>
        type.GetMembers().Any(member => member is IMethodSymbol method && IsGeneratedRegexDefinition(method));

    /// <summary>
    /// Whether <paramref name="symbol"/> is a member of the <c>Program</c>
    /// class of a C# top-level-statements program that is kept as a G# class
    /// because it declares a <c>[GeneratedRegex]</c> method. C# top-level
    /// statements are the body of <c>Program</c>'s synthesized entry point, so
    /// they reach its private members; G# top-level statements belong to the
    /// compiler's own <c>&lt;Program&gt;</c> type, so a private member would
    /// be inaccessible to them (GS0472). Such a member is emitted
    /// <c>internal</c>, no looser than the top-level func it becomes when the
    /// class is hoisted.
    /// </summary>
    /// <param name="symbol">A member (or nested type) with private accessibility.</param>
    /// <returns><see langword="true"/> when the member is widened to internal.</returns>
    private static bool IsMemberOfKeptTopLevelProgram(ISymbol symbol) =>
        symbol.ContainingType is INamedTypeSymbol owner
        && !owner.GetMembers(WellKnownMemberNames.TopLevelStatementsEntryPointMethodName).IsEmpty
        && DeclaresGeneratedRegexDefinition(owner);

    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Translates a C# <c>[GeneratedRegex]</c> partial definition to a G#
        /// declaring part (<c>@GeneratedRegex(...) partial func F() Regex;</c>),
        /// or reports the shapes G# cannot pair with gsgen's implementing part.
        /// </summary>
        /// <param name="node">The definition's declaration.</param>
        /// <param name="ownerKind">The G# kind of the containing type.</param>
        /// <param name="symbol">The definition's symbol.</param>
        /// <returns>The translated member and whether it is static.</returns>
        private (GMember Member, bool IsStatic) TranslateGeneratedRegexDefinition(
            MethodDeclarationSyntax node,
            TypeDeclarationKind ownerKind,
            IMethodSymbol symbol)
        {
            string problem = null;
            if (!this.preservePartialParts)
            {
                problem = "its type is merged into one non-partial G# type in this mode, which cannot hold a " +
                    "partial func (GS0608)";
            }
            else if (ownerKind is not (TypeDeclarationKind.Class or TypeDeclarationKind.Struct))
            {
                problem = "its type translates to a G# " + DescribeOwnerKind(ownerKind) + ", which cannot " +
                    "declare a partial func (GS0607); only a class or struct can";
            }
            else if (symbol.ContainingType?.ContainingType != null)
            {
                problem = "its type is nested, and gsgen generates implementing parts only for top-level types " +
                    "(the declaring part would have no implementation, GS0609); move the method to a " +
                    "top-level partial class";
            }

            if (problem != null)
            {
                string message =
                    $"[GeneratedRegex] method '{symbol.ContainingType?.Name}.{symbol.Name}' has no G# " +
                    $"declaring-part form: {problem}. The method is omitted, so every use of it fails to compile.";
                this.context.ReportUnsupported(node, message);
                return (null, false);
            }

            return this.TranslateMethod(node, ownerKind, isGeneratedRegexDefinition: true);
        }

        /// <summary>
        /// Maps the method-level attributes of a <c>[GeneratedRegex]</c>
        /// definition, re-spelling the <c>@GeneratedRegex</c> arguments from
        /// their bound constant values: positional, in constructor order.
        /// </summary>
        /// <param name="node">The definition's declaration.</param>
        /// <param name="symbol">The definition's symbol.</param>
        /// <returns>The mapped attributes.</returns>
        private List<AttributeUse> MapGeneratedRegexMethodAttributes(MethodDeclarationSyntax node, IMethodSymbol symbol)
        {
            var mappedTypes = new List<INamedTypeSymbol>();
            List<AttributeUse> mapped = this.MapAttributesWithTypes(node.AttributeLists, mappedTypes);
            AttributeData data = FindGeneratedRegexAttribute(symbol);
            var result = new List<AttributeUse>(mapped.Count);
            for (int index = 0; index < mapped.Count; index++)
            {
                AttributeUse attribute = mapped[index];
                bool methodTarget = attribute.Target == null || attribute.Target == "method";
                if (data == null
                    || !methodTarget
                    || !this.IsWellKnownAttribute(mappedTypes[index], GeneratedRegexAttributeName))
                {
                    result.Add(attribute);
                    continue;
                }

                var arguments = new List<AttributeArgument>(data.ConstructorArguments.Length);
                foreach (TypedConstant argument in data.ConstructorArguments)
                {
                    GExpression value = argument.Value == null
                        ? LiteralExpression.Null()
                        : this.MapConstantValue(argument.Value, argument.Type, node, "GeneratedRegex argument");
                    if (value == null)
                    {
                        // Not a constant G# can spell as a literal (the
                        // constructor takes only string, RegexOptions and
                        // int): keep the ordinary attribute translation.
                        return mapped;
                    }

                    arguments.Add(new AttributeArgument(value));
                }

                result.Add(new AttributeUse(attribute.Name, arguments, null));
            }

            return result;
        }

        private static string DescribeOwnerKind(TypeDeclarationKind ownerKind) => ownerKind switch
        {
            TypeDeclarationKind.DataClass => "data class (a C# record)",
            TypeDeclarationKind.DataStruct => "data struct (a C# record struct)",
            TypeDeclarationKind.InlineStruct => "inline struct",
            TypeDeclarationKind.Interface => "interface",
            _ => ownerKind.ToString(),
        };
    }
}
