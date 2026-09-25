// <copyright file="ImplementingPartHeaders.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.GeneratorHost;

/// <summary>
/// ADR-0192 follow-on 2, step 4: spells each generated G# implementing part
/// with its user declaring part's own header.
/// <para>
/// gsc pairs the two parts textually (GS0611 compares normalized header text,
/// and the grouping key compares parameter-type text), but the implementing
/// part is back-translated from the generator's C#, so it spells the header the
/// way cs2gs spells that C# — <c>Regex</c> and <c>int32</c> — while the user may
/// have written <c>System.Text.RegularExpressions.Regex</c> or <c>int</c>. So
/// the implementing part's header (every modifier through the return type,
/// method-level annotations excluded: gsc unions those, and each part keeps its
/// own) is replaced with the declaring part's header text, found through the
/// G# syntax tree of the printed <c>.g.gs</c> and of the user's file. The body
/// is kept.
/// </para>
/// <para>
/// The copied header must bind in the <c>.g.gs</c>, so the user file's imports
/// are added to it: every namespace import it lacks, and every alias import
/// the copied header names. An alias the <c>.g.gs</c> already binds to a
/// different target is a genuine clash; the header is then left as generated
/// and <c>GS9208</c> is reported. So is a parameter-name mismatch: the body
/// refers to the parameters by the generated names, which a generator takes
/// from the definition the stub rendered from the user's declaring part, so
/// they normally agree; copying a header whose names differ would rebind the
/// body to different parameters.
/// </para>
/// </summary>
internal static class ImplementingPartHeaders
{
    /// <summary>The gsgen diagnostic id for a header that could not be copied.</summary>
    public const string DiagnosticId = "GS9208";

    /// <summary>
    /// Returns the printed G# of <paramref name="unit"/> with every generated
    /// implementing part spelled with its declaring part's header.
    /// </summary>
    /// <param name="unit">The back-translated unit.</param>
    /// <param name="printed">The printed G# of <paramref name="unit"/>.</param>
    /// <param name="definitions">The lone declaring parts the stub rendered.</param>
    /// <param name="diagnostics">Receives a <c>GS9208</c> per header that could not be copied.</param>
    /// <returns>The rewritten G# source.</returns>
    public static string Apply(
        CompilationUnit unit,
        string printed,
        IReadOnlyList<StubPartialDefinition> definitions,
        List<GeneratorHostDiagnostic> diagnostics)
    {
        if (definitions.Count == 0 || !printed.Contains("partial", StringComparison.Ordinal))
        {
            return printed;
        }

        // First pass: which imports the copied headers need. Added to the
        // unit and re-printed, then planned again against the final text so
        // every splice offset is exact.
        var firstPassDiagnostics = new List<GeneratorHostDiagnostic>();
        var missingImports = new List<ImportDirective>();

        // The user file each added alias import came from, so a clash between
        // two user files merged into this one .g.gs names both of them.
        var aliasOrigins = new Dictionary<string, string>(StringComparer.Ordinal);
        Plan(unit, printed, definitions, firstPassDiagnostics, missingImports, aliasOrigins);
        if (missingImports.Count > 0)
        {
            var imports = new List<ImportDirective>(unit.Imports);
            imports.AddRange(missingImports);
            unit = new CompilationUnit(unit.Package, imports, unit.Members, unit.LeadingComments, unit.FileAttributes);
            printed = GSharpPrinter.Print(unit);
        }

        List<Splice> splices = Plan(unit, printed, definitions, diagnostics, new List<ImportDirective>(), aliasOrigins);
        var builder = new StringBuilder(printed);
        foreach (Splice splice in splices.OrderByDescending(s => s.Start))
        {
            builder.Remove(splice.Start, splice.Length);
            builder.Insert(splice.Start, splice.Text);
        }

        return builder.ToString();
    }

    private static List<Splice> Plan(
        CompilationUnit unit,
        string printed,
        IReadOnlyList<StubPartialDefinition> definitions,
        List<GeneratorHostDiagnostic> diagnostics,
        List<ImportDirective> missingImports,
        Dictionary<string, string> aliasOrigins)
    {
        var splices = new List<Splice>();
        GsSyntaxTree tree = GsSyntaxTree.Parse(SourceText.From(printed));
        var implementingParts = new List<FunctionDeclarationSyntax>();
        CollectImplementingParts(tree.Root, implementingParts);

        foreach (FunctionDeclarationSyntax implementing in implementingParts)
        {
            StubPartialDefinition definition = FindDeclaringPart(unit.Package, implementing, definitions);
            if (definition == null)
            {
                continue;
            }

            FunctionDeclarationSyntax declaring = definition.Declaration;
            string declaringHeader = HeaderText(declaring);
            if (HeaderSignature(declaring) == HeaderSignature(implementing))
            {
                continue;
            }

            string parameterMismatch = ParameterNameMismatch(declaring, implementing);
            if (parameterMismatch != null)
            {
                string message = $"the generated implementation of partial method '{declaring.Identifier.ValueText}' "
                    + $"names {parameterMismatch}; its header is left as generated, so gsc will report the two parts as mismatched";
                diagnostics.Add(new GeneratorHostDiagnostic(DiagnosticId, message, declaring.Identifier.Location));
                continue;
            }

            string aliasClash = AddMissingImports(unit, declaring, missingImports, aliasOrigins);
            if (aliasClash != null)
            {
                string message = $"the header of partial method '{declaring.Identifier.ValueText}' "
                    + $"cannot be copied into its generated implementation: {aliasClash}";
                diagnostics.Add(new GeneratorHostDiagnostic(DiagnosticId, message, declaring.Identifier.Location));
                continue;
            }

            TextSpan span = HeaderSpan(implementing);
            splices.Add(new Splice(span.Start, span.Length, declaringHeader));
        }

        return splices;
    }

    private static void CollectImplementingParts(SyntaxNode node, List<FunctionDeclarationSyntax> implementingParts)
    {
        foreach (SyntaxNode child in node.GetChildren())
        {
            if (child is FunctionDeclarationSyntax function)
            {
                if (function.IsPartial && function.Body != null)
                {
                    implementingParts.Add(function);
                }

                continue;
            }

            CollectImplementingParts(child, implementingParts);
        }
    }

    // The declaring part an implementing part pairs with: same package, same
    // top-level type (the stub renders only top-level types; `P` and `P[T]`
    // are different types, so the arity is part of it), same name and
    // parameter count. Overloads of one name with the same parameter count
    // cannot be told apart by spelling (their types are what differs), so an
    // ambiguous match copies nothing and the generated header stands.
    private static StubPartialDefinition FindDeclaringPart(
        string package,
        FunctionDeclarationSyntax implementing,
        IReadOnlyList<StubPartialDefinition> definitions)
    {
        StructDeclarationSyntax owner = EnclosingType(implementing);
        if (owner == null || owner.Parent is not CompilationUnitSyntax)
        {
            return null;
        }

        string typeName = owner.Identifier.ValueText;
        int typeArity = owner.TypeParameterList?.Parameters.Count ?? 0;
        string name = implementing.Identifier.ValueText;
        StubPartialDefinition match = null;
        foreach (StubPartialDefinition definition in definitions)
        {
            if (string.Equals(definition.PackageName ?? string.Empty, package ?? string.Empty, StringComparison.Ordinal)
                && string.Equals(definition.TypeName, typeName, StringComparison.Ordinal)
                && definition.TypeArity == typeArity
                && string.Equals(definition.Declaration.Identifier.ValueText, name, StringComparison.Ordinal)
                && definition.Declaration.Parameters.Count == implementing.Parameters.Count)
            {
                if (match != null)
                {
                    return null;
                }

                match = definition;
            }
        }

        return match;
    }

    private static StructDeclarationSyntax EnclosingType(SyntaxNode node)
    {
        for (SyntaxNode current = node.Parent; current != null; current = current.Parent)
        {
            if (current is StructDeclarationSyntax type)
            {
                return type;
            }
        }

        return null;
    }

    // Every parameter name must agree: the copied header's names replace the
    // generated ones, and the body refers to the generated ones.
    private static string ParameterNameMismatch(FunctionDeclarationSyntax declaring, FunctionDeclarationSyntax implementing)
    {
        for (int i = 0; i < declaring.Parameters.Count; i++)
        {
            string declared = declaring.Parameters[i].Identifier?.ValueText;
            string generated = implementing.Parameters[i].Identifier?.ValueText;
            if (declared == null || !string.Equals(declared, generated, StringComparison.Ordinal))
            {
                return $"parameter {i + 1} '{generated}' where its declaring part names it '{declared}'";
            }
        }

        return null;
    }

    // Queues the imports of the declaring part's file that the copied header
    // may need and the unit lacks. Returns a description of an alias clash,
    // or null. One .g.gs has one import scope, so an alias clashes with the
    // generated code's own imports, or with another user file whose declaring
    // part's header was copied into the same .g.gs (a partial class split
    // across files that alias the same name differently).
    private static string AddMissingImports(
        CompilationUnit unit,
        FunctionDeclarationSyntax declaring,
        List<ImportDirective> missingImports,
        Dictionary<string, string> aliasOrigins)
    {
        string file = declaring.SyntaxTree.Text.FileName;
        HashSet<string> headerIdentifiers = HeaderIdentifiers(declaring);
        foreach (MemberSyntax member in declaring.SyntaxTree.Root.Members)
        {
            if (member is not ImportSyntax import)
            {
                continue;
            }

            string target = string.Join(".", import.Identifiers.Select(identifier => identifier.ValueText));
            string alias = import.AliasIdentifier?.ValueText;
            if (alias == null)
            {
                if (!string.Equals(target, unit.Package, StringComparison.Ordinal)
                    && !HasImport(unit.Imports, target, null)
                    && !HasImport(missingImports, target, null))
                {
                    missingImports.Add(new ImportDirective(target));
                }

                continue;
            }

            if (!headerIdentifiers.Contains(alias))
            {
                continue;
            }

            string existing = AliasTarget(unit.Imports, alias) ?? AliasTarget(missingImports, alias);
            if (existing == null)
            {
                missingImports.Add(new ImportDirective(target, alias));
                aliasOrigins[alias] = file;
            }
            else if (!string.Equals(existing, target, StringComparison.Ordinal))
            {
                string origin = aliasOrigins.TryGetValue(alias, out string otherFile)
                    ? $"the header of another partial method, from '{otherFile}', needs it as '{existing}'"
                    : $"the generated code imports it as '{existing}'";
                return $"it needs 'import {alias} = {target}' from '{file}', but {origin}, "
                    + "and the generated file has one import scope";
            }
        }

        return null;
    }

    private static bool HasImport(IReadOnlyList<ImportDirective> imports, string name, string alias)
    {
        foreach (ImportDirective import in imports)
        {
            if (string.Equals(import.Name, name, StringComparison.Ordinal)
                && string.Equals(import.Alias, alias, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string AliasTarget(IReadOnlyList<ImportDirective> imports, string alias)
    {
        foreach (ImportDirective import in imports)
        {
            if (string.Equals(import.Alias, alias, StringComparison.Ordinal))
            {
                return import.Name;
            }
        }

        return null;
    }

    private static HashSet<string> HeaderIdentifiers(FunctionDeclarationSyntax declaration)
    {
        TextSpan header = HeaderSpan(declaration);
        var identifiers = new HashSet<string>(StringComparer.Ordinal);
        CollectIdentifiers(declaration, header, identifiers);
        return identifiers;
    }

    private static void CollectIdentifiers(SyntaxNode node, TextSpan header, HashSet<string> identifiers)
    {
        foreach (SyntaxNode child in node.GetChildren())
        {
            if (child.Span.End <= header.Start || child.Span.Start >= header.End)
            {
                continue;
            }

            if (child is SyntaxToken token)
            {
                if (token.Kind == SyntaxKind.IdentifierToken)
                {
                    identifiers.Add(token.ValueText);
                }

                continue;
            }

            CollectIdentifiers(child, header, identifiers);
        }
    }

    private static string HeaderText(FunctionDeclarationSyntax declaration) =>
        declaration.SyntaxTree.Text.ToString(HeaderSpan(declaration));

    // From the first modifier (or `func`) through the return type — or the
    // closing parenthesis of a function with none. Method-level annotations
    // precede it and the body or `;` follows it, so both are left alone.
    private static TextSpan HeaderSpan(FunctionDeclarationSyntax declaration)
    {
        int start = declaration.FunctionKeyword.Span.Start;
        foreach (SyntaxNode child in declaration.GetChildren())
        {
            if (child is AnnotationSyntax || child is BlockStatementSyntax)
            {
                continue;
            }

            if (child.Span.Start < start)
            {
                start = child.Span.Start;
            }
        }

        int end = declaration.CloseParenthesisToken.Span.End;
        if (declaration.Type != null && declaration.Type.Span.End > end)
        {
            end = declaration.Type.Span.End;
        }

        return TextSpan.FromBounds(start, end);
    }

    // The header's tokens as gsc's pairing check compares them
    // (PartialMethodMerger.TokenSignature): trivia between tokens is
    // ignored, but every token keeps its own text, so string defaults "a b"
    // and "a  b" differ. Built from the header's children in source order.
    private static string HeaderSignature(FunctionDeclarationSyntax declaration)
    {
        TextSpan header = HeaderSpan(declaration);
        var children = new List<SyntaxNode>();
        foreach (SyntaxNode child in declaration.GetChildren())
        {
            if (child.Span.Start >= header.Start && child.Span.End <= header.End && child.Span.Length > 0)
            {
                children.Add(child);
            }
        }

        var builder = new StringBuilder();
        foreach (SyntaxNode child in children.OrderBy(node => node.Span.Start))
        {
            builder.Append(PartialMethodMerger.TokenSignature(child));
        }

        return builder.ToString();
    }

    private sealed class Splice
    {
        public Splice(int start, int length, string text)
        {
            Start = start;
            Length = length;
            Text = text;
        }

        public int Start { get; }

        public int Length { get; }

        public string Text { get; }
    }
}
