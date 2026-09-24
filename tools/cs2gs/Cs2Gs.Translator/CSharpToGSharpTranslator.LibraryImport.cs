// <copyright file="CSharpToGSharpTranslator.LibraryImport.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Cs2Gs.Translator;

/// <summary>
/// Issue #4370: C# <c>[LibraryImport]</c> partial methods, and the safety net
/// for any other partial member whose implementation a source generator
/// produces.
/// </summary>
/// <remarks>
/// <para>A <c>[LibraryImport]</c> method is a C# partial DEFINITION whose
/// implementation the LibraryImportGenerator writes. cs2gs never translates
/// generator output, and the G# SDK removes that generator from gsgen, so
/// the ordinary partial-method rule (skip the definition, translate the
/// implementation) used to drop the method entirely while its callers
/// survived — a translation that PASSed and then failed in gsc with GS0130.
/// gsc supports <c>@LibraryImport</c> natively (ADR-0092): a body-less
/// <c>@LibraryImport(...) func F(...) R;</c> is a complete declaration from
/// which gsc emits the marshalling stub and inner P/Invoke. So the
/// definition translates to exactly that, as a static member of its type
/// (<c>shared</c>), keeping its accessibility, parameters, ref kinds and
/// parameter/return attributes; the generated implementation is not
/// needed.</para>
/// <para>The <c>[LibraryImport]</c> surface gsc does not honour — a custom
/// string marshaller, <c>[MarshalUsing]</c>/<c>[NativeMarshalling]</c>
/// custom marshallers, an <c>[UnmanagedCallConv]</c> other than cdecl, and a return-value
/// <c>[MarshalAs]</c> other than <c>UnmanagedType.Bool</c> — would
/// otherwise compile with different marshalling, so each is reported as a
/// translation gap.</para>
/// </remarks>
public sealed partial class CSharpToGSharpTranslator
{
    private const string LibraryImportAttributeName = "System.Runtime.InteropServices.LibraryImportAttribute";

    private const string GeneratedRegexAttributeName = "System.Text.RegularExpressions.GeneratedRegexAttribute";

    private static bool HasAttribute(ISymbol symbol, string attributeName) =>
        symbol.GetAttributes().Any(attribute => attribute.AttributeClass?.ToDisplayString() == attributeName);

    /// <summary>
    /// Whether <paramref name="method"/> is the definition part of a C#
    /// <c>[LibraryImport]</c> partial method.
    /// </summary>
    /// <param name="method">The method symbol (any part).</param>
    /// <returns><see langword="true"/> for a <c>[LibraryImport]</c> partial definition.</returns>
    private static bool IsLibraryImportDefinition(IMethodSymbol method) =>
        method != null
        && method.IsPartialDefinition
        && FindLibraryImportAttribute(method) != null;

    private static AttributeData FindLibraryImportAttribute(IMethodSymbol method) =>
        method.GetAttributes().FirstOrDefault(attribute =>
            attribute.AttributeClass?.ToDisplayString() == LibraryImportAttributeName);

    private static bool IsMarshalAsAttributeName(string name)
    {
        string simpleName = name.Substring(name.LastIndexOf('.') + 1);
        return simpleName == "MarshalAs" || simpleName == "MarshalAsAttribute";
    }

    /// <summary>
    /// The StringMarshalling (1 = Utf8, 2 = Utf16) every string parameter and
    /// a string return of <paramref name="method"/> use, folding a per-string
    /// <c>[MarshalAs(LPUTF8Str)]</c> / <c>[MarshalAs(LPWStr)]</c> into it.
    /// gsc has no per-string encoding under <c>@LibraryImport</c> (GS0360),
    /// so a string <c>[MarshalAs]</c> it cannot express, or strings that
    /// disagree, set <paramref name="problem"/>.
    /// </summary>
    /// <param name="method">The <c>[LibraryImport]</c> definition.</param>
    /// <param name="usesMarshalAs">Whether any string position carries <c>[MarshalAs]</c>.</param>
    /// <param name="problem">Why no single encoding exists, or <see langword="null"/>.</param>
    /// <returns>The shared encoding, or 0 when none is known.</returns>
    private static int ResolveLibraryImportStringMarshalling(
        IMethodSymbol method,
        out bool usesMarshalAs,
        out string problem)
    {
        usesMarshalAs = false;
        problem = null;
        int attributeEncoding = 0;
        AttributeData libraryImport = FindLibraryImportAttribute(method);
        foreach (KeyValuePair<string, TypedConstant> named in libraryImport.NamedArguments)
        {
            if (named.Key == "StringMarshalling" && named.Value.Value is int value)
            {
                attributeEncoding = value;
            }
        }

        var stringAttributes = new List<IEnumerable<AttributeData>>();
        var stringPositions = new List<string>();
        foreach (IParameterSymbol parameter in method.Parameters)
        {
            if (parameter.Type.SpecialType == SpecialType.System_String)
            {
                stringAttributes.Add(parameter.GetAttributes());
                stringPositions.Add($"parameter '{parameter.Name}'");
            }
        }

        if (method.ReturnType.SpecialType == SpecialType.System_String)
        {
            stringAttributes.Add(method.GetReturnTypeAttributes());
            stringPositions.Add("the return value");
        }

        var encodings = new HashSet<int>();
        for (int i = 0; i < stringAttributes.Count; i++)
        {
            string position = stringPositions[i];
            AttributeData marshalAs = stringAttributes[i].FirstOrDefault(attribute =>
                attribute.AttributeClass?.ToDisplayString() == "System.Runtime.InteropServices.MarshalAsAttribute");
            if (marshalAs == null)
            {
                if (attributeEncoding == 1 || attributeEncoding == 2)
                {
                    encodings.Add(attributeEncoding);
                }

                continue;
            }

            usesMarshalAs = true;
            int unmanagedType = marshalAs.ConstructorArguments.Length == 1 && marshalAs.ConstructorArguments[0].Value is int raw
                ? raw
                : -1;
            if (unmanagedType == (int)System.Runtime.InteropServices.UnmanagedType.LPUTF8Str)
            {
                encodings.Add(1);
            }
            else if (unmanagedType == (int)System.Runtime.InteropServices.UnmanagedType.LPWStr)
            {
                encodings.Add(2);
            }
            else if (problem == null)
            {
                problem = $"{position} is a string with [MarshalAs(UnmanagedType." +
                    $"{(System.Runtime.InteropServices.UnmanagedType)unmanagedType})], which gsc's @LibraryImport " +
                    "cannot express (only UTF-8 and UTF-16 via StringMarshalling)";
            }
        }

        if (problem == null && encodings.Count > 1)
        {
            problem = "its string parameters/return use different encodings, but gsc applies one " +
                "StringMarshalling to every string of an @LibraryImport";
        }

        return problem == null && encodings.Count == 1 ? encodings.First() : 0;
    }

    private static bool IsLibraryImportAttributeName(string name)
    {
        string simpleName = name.Substring(name.LastIndexOf('.') + 1);
        return simpleName == "LibraryImport" || simpleName == "LibraryImportAttribute";
    }

    private sealed partial class DeclarationVisitor
    {
        /// <summary>
        /// Translates a C# <c>[LibraryImport]</c> partial definition to the
        /// native body-less G# <c>@LibraryImport</c> declaration, after
        /// reporting every part of its marshalling surface gsc would not
        /// honour.
        /// </summary>
        /// <param name="node">The definition's declaration.</param>
        /// <param name="ownerKind">The G# kind of the containing type.</param>
        /// <param name="symbol">The definition's symbol.</param>
        /// <returns>The translated member and whether it is static.</returns>
        private (GMember Member, bool IsStatic) TranslateLibraryImportDefinition(
            MethodDeclarationSyntax node,
            TypeDeclarationKind ownerKind,
            IMethodSymbol symbol)
        {
            this.ReportUnsupportedLibraryImportSurface(node, symbol);
            return this.TranslateMethod(node, ownerKind, isNativeImportDefinition: true);
        }

        /// <summary>
        /// Maps the method-level attributes of a <c>[LibraryImport]</c>
        /// definition. The <c>@LibraryImport</c> arguments gsc reads (the
        /// library name, <c>EntryPoint</c>, <c>SetLastError</c>,
        /// <c>StringMarshalling</c>) are re-spelled from their compile-time
        /// constant values, so a library name written as a <c>const</c>
        /// (<c>[LibraryImport(NativeLibName)]</c>) reaches gsc as the string
        /// literal its P/Invoke binder requires.
        /// </summary>
        /// <param name="node">The definition's declaration.</param>
        /// <param name="symbol">The definition's symbol.</param>
        /// <returns>The mapped attributes.</returns>
        private List<AttributeUse> MapLibraryImportMethodAttributes(MethodDeclarationSyntax node, IMethodSymbol symbol)
        {
            List<AttributeUse> mapped = this.MapAttributes(node.AttributeLists);
            AttributeData data = FindLibraryImportAttribute(symbol);
            if (data == null)
            {
                return mapped;
            }

            // A per-string [MarshalAs(LPUTF8Str/LPWStr)] becomes the import's
            // StringMarshalling (gsc has no per-string encoding).
            int foldedEncoding = ResolveLibraryImportStringMarshalling(symbol, out bool usesMarshalAs, out _);
            GExpression foldedStringMarshalling = usesMarshalAs && foldedEncoding != 0
                ? this.MapConstantValue(
                    foldedEncoding,
                    this.context.Compilation.GetTypeByMetadataName("System.Runtime.InteropServices.StringMarshalling"),
                    node,
                    "LibraryImport StringMarshalling")
                : null;
            bool stringReturn = symbol.ReturnType.SpecialType == SpecialType.System_String;

            var result = new List<AttributeUse>(mapped.Count);
            foreach (AttributeUse attribute in mapped)
            {
                if (attribute.Target == "return" && stringReturn && IsMarshalAsAttributeName(attribute.Name))
                {
                    continue;
                }

                if (attribute.Target != null || !IsLibraryImportAttributeName(attribute.Name))
                {
                    result.Add(attribute);
                    continue;
                }

                var arguments = new List<AttributeArgument>(attribute.Arguments.Count);
                bool hasStringMarshalling = false;
                foreach (AttributeArgument argument in attribute.Arguments)
                {
                    GExpression constant = argument.Name == "StringMarshalling" && foldedStringMarshalling != null
                        ? foldedStringMarshalling
                        : this.MapLibraryImportArgumentConstant(data, argument.Name, node);
                    hasStringMarshalling |= argument.Name == "StringMarshalling";
                    arguments.Add(constant == null ? argument : new AttributeArgument(constant, argument.Name));
                }

                if (!hasStringMarshalling && foldedStringMarshalling != null)
                {
                    arguments.Add(new AttributeArgument(foldedStringMarshalling, "StringMarshalling"));
                }

                result.Add(new AttributeUse(attribute.Name, arguments, attribute.Target));
            }

            return result;
        }

        private GExpression MapLibraryImportArgumentConstant(AttributeData data, string name, SyntaxNode node)
        {
            if (name == null)
            {
                return data.ConstructorArguments.Length == 1
                    && data.ConstructorArguments[0].Value is string libraryName
                        ? LiteralExpression.String(libraryName)
                        : null;
            }

            if (name != "EntryPoint" && name != "SetLastError" && name != "StringMarshalling")
            {
                return null;
            }

            foreach (KeyValuePair<string, TypedConstant> named in data.NamedArguments)
            {
                if (named.Key == name && named.Value.Kind != TypedConstantKind.Error && named.Value.Value != null)
                {
                    return this.MapConstantValue(named.Value.Value, named.Value.Type, node, "LibraryImport " + name);
                }
            }

            return null;
        }

        private void ReportUnsupportedLibraryImportSurface(MethodDeclarationSyntax node, IMethodSymbol symbol)
        {
            string name = symbol.Name;
            AttributeData data = FindLibraryImportAttribute(symbol);
            if (data != null && data.NamedArguments.Any(named =>
                named.Key == "StringMarshallingCustomType" && named.Value.Value != null))
            {
                string message =
                    $"[LibraryImport] method '{name}' names a StringMarshallingCustomType; gsc's native " +
                    "@LibraryImport accepts the argument but runs no custom string marshaller (ADR-0092), " +
                    "so the translated import would marshal strings differently.";
                this.context.ReportUnsupported(node, message);
            }

            this.ReportUnmanagedCallConv(node, symbol);

            ResolveLibraryImportStringMarshalling(symbol, out _, out string stringProblem);
            if (stringProblem != null)
            {
                string stringMessage = $"[LibraryImport] method '{name}': {stringProblem}.";
                this.context.ReportUnsupported(node, stringMessage);
            }

            foreach (IParameterSymbol parameter in symbol.Parameters)
            {
                string subject = $"parameter '{parameter.Name}' of [LibraryImport] method '{name}'";
                this.ReportCustomMarshaller(node, subject, parameter.GetAttributes(), parameter.Type);
            }

            string returnSubject = $"the return value of [LibraryImport] method '{name}'";
            List<AttributeData> returnAttributes = symbol.GetReturnTypeAttributes().ToList();
            this.ReportCustomMarshaller(node, returnSubject, returnAttributes, symbol.ReturnType);

            AttributeData returnMarshalAs = returnAttributes.FirstOrDefault(attribute =>
                attribute.AttributeClass?.ToDisplayString() == "System.Runtime.InteropServices.MarshalAsAttribute");
            if (returnMarshalAs != null
                && symbol.ReturnType.SpecialType != SpecialType.System_String
                && !(returnMarshalAs.ConstructorArguments.Length == 1
                    && returnMarshalAs.ConstructorArguments[0].Value is int unmanagedType
                    && unmanagedType == (int)System.Runtime.InteropServices.UnmanagedType.Bool))
            {
                string message =
                    $"{returnSubject} carries [return: MarshalAs] other than UnmanagedType.Bool; gsc applies " +
                    "no return-value MarshalAs to a P/Invoke (a 'bool' return always marshals as a 4-byte " +
                    "BOOL), so the translated import would read the native return differently.";
                this.context.ReportUnsupported(node, message);
            }

            if (symbol.ReturnType.SpecialType == SpecialType.System_String)
            {
                string message =
                    $"[LibraryImport] method '{name}' returns 'string'. The C# generator frees the returned " +
                    "native buffer with Marshal.FreeCoTaskMem; gsc's @LibraryImport treats it as non-owning and " +
                    "never frees it (ADR-0092). Check who owns the buffer: a caller-frees API now leaks.";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.MethodDeclaration),
                    message,
                    node.GetLocation(),
                    TranslationSeverity.Warning));
            }
        }

        /// <summary>
        /// gsc's <c>@LibraryImport</c> always binds the inner P/Invoke with the
        /// platform-default calling convention and does not read
        /// <c>[UnmanagedCallConv]</c>. <c>CallConvCdecl</c> alone (the
        /// common shape — every Raylib-cs import carries it) is that default
        /// on every platform except 32-bit Windows, so it translates with a
        /// warning; any other calling convention or modifier is a gap.
        /// </summary>
        private void ReportUnmanagedCallConv(MethodDeclarationSyntax node, IMethodSymbol symbol)
        {
            AttributeData callConv = symbol.GetAttributes().FirstOrDefault(attribute =>
                attribute.AttributeClass?.ToDisplayString() ==
                    "System.Runtime.InteropServices.UnmanagedCallConvAttribute");
            if (callConv == null)
            {
                return;
            }

            bool cdeclOnly = callConv.NamedArguments.All(named =>
                named.Key == "CallConvs"
                && named.Value.Kind == TypedConstantKind.Array
                && named.Value.Values.All(value =>
                    value.Value is ITypeSymbol type
                    && type.ToDisplayString() == "System.Runtime.CompilerServices.CallConvCdecl"));
            if (cdeclOnly)
            {
                string warning =
                    $"[LibraryImport] method '{symbol.Name}' carries [UnmanagedCallConv(CallConvCdecl)]; gsc's " +
                    "@LibraryImport uses the platform-default calling convention, which is cdecl everywhere " +
                    "except 32-bit Windows (stdcall).";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.MethodDeclaration),
                    warning,
                    node.GetLocation(),
                    TranslationSeverity.Warning));
                return;
            }

            string message =
                $"[LibraryImport] method '{symbol.Name}' carries an [UnmanagedCallConv] other than " +
                "CallConvCdecl; gsc's native @LibraryImport always uses the platform-default calling " +
                "convention (ADR-0092) and would not apply it.";
            this.context.ReportUnsupported(node, message);
        }

        private void ReportCustomMarshaller(
            SyntaxNode node,
            string subject,
            IEnumerable<AttributeData> attributes,
            ITypeSymbol type)
        {
            if (attributes.Any(attribute =>
                attribute.AttributeClass?.ToDisplayString() ==
                    "System.Runtime.InteropServices.Marshalling.MarshalUsingAttribute"))
            {
                string message =
                    $"{subject} carries [MarshalUsing]; gsc's native @LibraryImport has no custom marshallers " +
                    "(ADR-0092).";
                this.context.ReportUnsupported(node, message);
            }

            ITypeSymbol marshalledType = type is IArrayTypeSymbol array ? array.ElementType : type;
            if (marshalledType != null && marshalledType.GetAttributes().Any(attribute =>
                attribute.AttributeClass?.ToDisplayString() ==
                    "System.Runtime.InteropServices.Marshalling.NativeMarshallingAttribute"))
            {
                string message =
                    $"{subject} has type '{marshalledType.Name}', which declares a [NativeMarshalling] custom " +
                    "marshaller; gsc's native @LibraryImport has no custom marshallers (ADR-0092).";
                this.context.ReportUnsupported(node, message);
            }
        }

        /// <summary>
        /// Whether this run emits <paramref name="tree"/>: membership in the
        /// caller's translated-file set when it supplied one (a repository
        /// migration translates git-tracked <c>&lt;auto-generated&gt;</c>
        /// files too), otherwise the loader's own generated-source rule.
        /// </summary>
        private bool IsTranslatedByThisRun(Microsoft.CodeAnalysis.SyntaxTree tree) =>
            this.translatedFilePaths != null
                ? this.translatedFilePaths.Contains(tree.FilePath)
                : this.IsHandAuthoredTranslatedTree(tree);

        /// <summary>
        /// Issue #4370 safety net: reports a partial member whose definition
        /// this run translates but whose implementation is generated code
        /// that cs2gs does not translate (a source generator other than the
        /// ones cs2gs rewrites itself — <c>[GeneratedRegex]</c> and
        /// <c>[LibraryImport]</c>). The definition has no G# form without
        /// its implementation (a lone declaring part is GS0609), so the
        /// member is omitted; without this report the translation would
        /// PASS with the member silently missing and its callers failing in
        /// gsc.
        /// </summary>
        /// <param name="node">The definition's declaration.</param>
        /// <param name="definition">The partial definition's symbol.</param>
        /// <param name="implementation">Its implementation part, if any.</param>
        private void ReportGeneratedPartialImplementation(
            MemberDeclarationSyntax node,
            ISymbol definition,
            ISymbol implementation)
        {
            if (implementation == null
                || implementation.DeclaringSyntaxReferences.Length == 0
                || !this.IsTranslatedByThisRun(node.SyntaxTree)
                || implementation.DeclaringSyntaxReferences.Any(reference =>
                    this.IsTranslatedByThisRun(reference.SyntaxTree))
                || (definition is IMethodSymbol && HasAttribute(definition, GeneratedRegexAttributeName)))
            {
                return;
            }

            string generatedFile = implementation.DeclaringSyntaxReferences[0].SyntaxTree.FilePath;
            string remedy = HasAttribute(definition, GeneratedRegexAttributeName)
                ? "cs2gs rewrites [GeneratedRegex] only on partial METHODS; declare it as a partial method, or " +
                    "write the cached Regex by hand in G#."
                : HasAttribute(definition, "CommunityToolkit.Mvvm.ComponentModel.ObservablePropertyAttribute")
                    ? "use the field form of [ObservableProperty], which gsgen regenerates for G#, or implement " +
                        "the property by hand in G#."
                    : "cs2gs rewrites only [GeneratedRegex] and [LibraryImport] partial methods; implement this " +
                        "member by hand in G#.";
            string message =
                $"partial member '{definition.ContainingType?.Name}.{definition.Name}' is implemented by " +
                $"generated code ('{generatedFile}') that cs2gs does not translate; the member is omitted from " +
                "the G# type, so every use of it fails to compile. " + remedy;
            this.context.ReportUnsupported(node, message);
        }
    }
}
