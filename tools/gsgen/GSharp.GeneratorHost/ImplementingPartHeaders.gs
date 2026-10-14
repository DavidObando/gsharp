// <copyright file="ImplementingPartHeaders.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import System
import System.Collections.Generic
import System.Linq
import System.Text
import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree

/// ADR-0192 follow-on 2, step 4: spells each generated G# implementing part
/// with its user declaring part's own header.
///
/// gsc pairs the two parts textually (GS0611 compares normalized header text,
/// and the grouping key compares parameter-type text), but the implementing
/// part is back-translated from the generator's C#, so it spells the header the
/// way cs2gs spells that C# — `Regex` and `int32` — while the user may
/// have written `System.Text.RegularExpressions.Regex` or `int`. So
/// the implementing part's header (every modifier through the return type,
/// method-level annotations excluded: gsc unions those, and each part keeps its
/// own) is replaced with the declaring part's header text, found through the
/// G# syntax tree of the printed `.g.gs` and of the user's file. The body
/// is kept.
///
/// The copied header must bind in the `.g.gs`, so the user file's imports
/// are added to it: every namespace import it lacks, and every alias import
/// the copied header names. An alias the `.g.gs` already binds to a
/// different target is a genuine clash; the header is then left as generated
/// and `GS9208` is reported. So is a parameter-name mismatch: the body
/// refers to the parameters by the generated names, which a generator takes
/// from the definition the stub rendered from the user's declaring part, so
/// they normally agree; copying a header whose names differ would rebind the
/// body to different parameters.
internal shared class ImplementingPartHeaders {
    private class Splice {
        init(start int32, length int32, text string) {
            Start = start
            Length = length
            Text = text
        }

        prop Start int32 {
            get;
        }

        prop Length int32 {
            get;
        }

        prop Text string {
            get;
        }
    }

    /// The gsgen diagnostic id for a header that could not be copied.
    const DiagnosticId string = "GS9208"

    /// Returns the printed G# of [`unit`](paramref) with every generated
    /// implementing part spelled with its declaring part's header.
    /// @param unit The back-translated unit.
    /// @param printed The printed G# of [`unit`](paramref).
    /// @param definitions The lone declaring parts the stub rendered.
    /// @param diagnostics Receives a `GS9208` per header that could not be copied.
    /// @returns The rewritten G# source.
    func Apply(
        unit CompilationUnit,
        printed string,
        definitions IReadOnlyList[StubPartialDefinition],
        diagnostics List[GeneratorHostDiagnostic]
    ) string {
        var unit = unit
        var printed = printed
        if definitions.Count == 0 || !printed.Contains("partial", StringComparison.Ordinal) {
            return printed
        }
        // First pass: which imports the copied headers need. Added to the
        // unit and re-printed, then planned again against the final text so
        // every splice offset is exact.
        let firstPassDiagnostics = List[GeneratorHostDiagnostic]()
        let missingImports = List[ImportDirective]()
        // The user file each added alias import came from, so a clash between
        // two user files merged into this one .g.gs names both of them.
        let aliasOrigins = Dictionary[string, string](StringComparer.Ordinal)
        Plan(unit, printed, definitions, firstPassDiagnostics, missingImports, aliasOrigins)
        if missingImports.Count > 0 {
            let imports = List[ImportDirective](unit.Imports)
            imports.AddRange(missingImports)
            unit = CompilationUnit(unit.Package, imports, unit.Members, unit.LeadingComments, unit.FileAttributes)
            printed = GSharpPrinter.Print(unit)
        }
        let splices = Plan(unit, printed, definitions, diagnostics, List[ImportDirective](), aliasOrigins)
        let builder = StringBuilder(printed)
        for splice in splices.OrderByDescending((s Splice) -> s.Start) {
            builder.Remove(splice.Start, splice.Length)
            builder.Insert(splice.Start, splice.Text)
        }
        return builder.ToString()
    }

    private func Plan(
        unit CompilationUnit,
        printed string,
        definitions IReadOnlyList[StubPartialDefinition],
        diagnostics List[GeneratorHostDiagnostic],
        missingImports List[ImportDirective],
        aliasOrigins Dictionary[string, string]
    ) List[Splice] {
        let splices = List[Splice]()
        let tree = GsSyntaxTree.Parse(SourceText.From(printed))
        let implementingParts = List[FunctionDeclarationSyntax]()
        CollectImplementingParts(tree.Root, implementingParts)
        for implementing in implementingParts {
            let definition StubPartialDefinition? = FindDeclaringPart(unit.Package!!, implementing, definitions)
            if definition == nil {
                continue
            }
            let declaring = definition.Declaration
            let declaringHeader = HeaderText(declaring)
            if HeaderSignature(declaring) == HeaderSignature(implementing) {
                continue
            }
            let parameterMismatch string? = ParameterNameMismatch(declaring, implementing)
            if parameterMismatch != nil {
                let message = "the generated implementation of partial method '${declaring.Identifier.ValueText}' " +
                    "names $parameterMismatch; its header is left as generated, so gsc will report the two parts as mismatched"
                diagnostics.Add(GeneratorHostDiagnostic(DiagnosticId, message, declaring.Identifier.Location))
                continue
            }
            let aliasClash string? = AddMissingImports(unit, declaring, missingImports, aliasOrigins)
            if aliasClash != nil {
                let message = "the header of partial method '${declaring.Identifier.ValueText}' " +
                    "cannot be copied into its generated implementation: $aliasClash"
                diagnostics.Add(GeneratorHostDiagnostic(DiagnosticId, message, declaring.Identifier.Location))
                continue
            }
            let span = HeaderSpan(implementing)
            splices.Add(Splice(span.Start, span.Length, declaringHeader))
        }
        return splices
    }

    private func CollectImplementingParts(node SyntaxNode, implementingParts List[FunctionDeclarationSyntax]) {
        for child in node.GetChildren() {
            if child is FunctionDeclarationSyntax function {
                if function.IsPartial && function.Body != nil {
                    implementingParts.Add(function)
                }
                continue
            }
            CollectImplementingParts(child, implementingParts)
        }
    }

    // The declaring part an implementing part pairs with: same package, same
    // top-level type (the stub renders only top-level types; `P` and `P[T]`
    // are different types, so the arity is part of it), same name and
    // parameter count. Overloads of one name with the same parameter count
    // cannot be told apart by spelling (their types are what differs), so an
    // ambiguous match copies nothing and the generated header stands.
    private func FindDeclaringPart(
        $package string,
        implementing FunctionDeclarationSyntax,
        definitions IReadOnlyList[StubPartialDefinition]
    ) StubPartialDefinition? {
        let owner StructDeclarationSyntax? = EnclosingType(implementing)
        if owner == nil || !(owner.Parent is CompilationUnitSyntax) {
            return nil
        }
        let typeName = owner.Identifier.ValueText
        let typeArity = owner.TypeParameterList?.Parameters.Count ?? 0
        let name = implementing.Identifier.ValueText
        var match StubPartialDefinition? = nil
        for definition in definitions {
            if string.Equals(
                definition.PackageName ?? string.Empty,
                $package ?? string.Empty,
                StringComparison.Ordinal
            ) &&
                string.Equals(definition.TypeName, typeName, StringComparison.Ordinal) &&
                definition.TypeArity == typeArity &&
                string.Equals(definition.Declaration.Identifier.ValueText, name, StringComparison.Ordinal) &&
                definition
                .Declaration
                .Parameters
                .Count == implementing
                .Parameters
                .Count {
                if match != nil {
                    return nil
                }
                match = definition
            }
        }
        return match
    }

    private func EnclosingType(node SyntaxNode) StructDeclarationSyntax? {
        for var current SyntaxNode? = node.Parent; current != nil; current = current!!.Parent {
            if current is StructDeclarationSyntax type {
                return type
            }
        }
        return nil
    }

    // Every parameter name must agree: the copied header's names replace the
    // generated ones, and the body refers to the generated ones.
    private func ParameterNameMismatch(
        declaring FunctionDeclarationSyntax,
        implementing FunctionDeclarationSyntax
    ) string? {
        for var i = 0; i < declaring.Parameters.Count; i++ {
            let declared string? = declaring.Parameters[i].Identifier?.ValueText
            let generated string? = implementing.Parameters[i].Identifier?.ValueText
            if declared == nil || !string.Equals(declared, generated, StringComparison.Ordinal) {
                return "parameter ${i + 1} '$generated' where its declaring part names it '$declared'"
            }
        }
        return nil
    }

    // Queues the imports of the declaring part's file that the copied header
    // may need and the unit lacks. Returns a description of an alias clash,
    // or null. One .g.gs has one import scope, so an alias clashes with the
    // generated code's own imports, or with another user file whose declaring
    // part's header was copied into the same .g.gs (a partial class split
    // across files that alias the same name differently).
    private func AddMissingImports(
        unit CompilationUnit,
        declaring FunctionDeclarationSyntax,
        missingImports List[ImportDirective],
        aliasOrigins Dictionary[string, string]
    ) string? {
        let file = declaring.SyntaxTree.Text.FileName
        let headerIdentifiers = HeaderIdentifiers(declaring)
        // Built transactionally: this header's imports and alias origins are
        // collected locally and merged only when no alias clashes, so a header
        // that is not copied leaves no stale alias to block a later one.
        let pendingImports = List[ImportDirective]()
        let pendingOrigins = Dictionary[string, string](StringComparer.Ordinal)
        for member in declaring.SyntaxTree.Root.Members {
            if member is not ImportSyntax import_ {
                continue
            }
            // The G# spelling, escapes kept (`$class`): this text is printed
            // into the .g.gs as written, and cs2gs spells its own imports the
            // same way. ValueText would drop the `$` and print a keyword.
            let target = string.Join(".", import_.Identifiers.Select((identifier SyntaxToken) -> identifier.Text))
            let alias string? = import_.AliasIdentifier?.Text
            if alias == nil {
                if !string.Equals(target, unit.Package, StringComparison.Ordinal) &&
                    !HasImport(unit.Imports, target, nil) &&
                    !HasImport(missingImports, target, nil) &&
                    !HasImport(pendingImports, target, nil) {
                    pendingImports.Add(ImportDirective(target))
                }
                continue
            }
            if !headerIdentifiers.Contains(import_.AliasIdentifier!!.ValueText) {
                continue
            }
            let existing string? = AliasTarget(unit.Imports, alias) ??
                AliasTarget(missingImports, alias) ??
                AliasTarget(pendingImports, alias)
            if existing == nil {
                pendingImports.Add(ImportDirective(target, alias))
                pendingOrigins[alias] = file
            } else if !string.Equals(existing, target, StringComparison.Ordinal) {
                let origin = if aliasOrigins.TryGetValue(alias, out var otherFile) || pendingOrigins.TryGetValue(
                    alias,
                    out otherFile
                ) {
                    "the header of another partial method, from '$otherFile', needs it as '$existing'"
                } else {
                    "the generated code imports it as '$existing'"
                }
                return "it needs 'import $alias = $target' from '$file', but $origin, " +
                    "and the generated file has one import scope"
            }
        }
        missingImports.AddRange(pendingImports)
        for origin in pendingOrigins {
            aliasOrigins[origin.Key] = origin.Value
        }
        return nil
    }

    private func HasImport(imports IReadOnlyList[ImportDirective], name string, alias string?) bool {
        for import_ in imports {
            if string.Equals(import_.Name, name, StringComparison.Ordinal) && string.Equals(
                import_.Alias,
                alias,
                StringComparison.Ordinal
            ) {
                return true
            }
        }
        return false
    }

    private func AliasTarget(imports IReadOnlyList[ImportDirective], alias string) string? {
        for import_ in imports {
            if string.Equals(import_.Alias, alias, StringComparison.Ordinal) {
                return import_.Name
            }
        }
        return nil
    }

    // The names in the header that an import alias could resolve: the bare
    // identifiers and the LEFTMOST segment of every qualified name, in type
    // positions, default values and annotations (`R` in `R.Regex`, never the
    // `Regex` in `System.Text.RegularExpressions.Regex`). Each generic type
    // argument is a name of its own. Worked out from the parsed syntax, so
    // names the header declares (the method, its parameters and type
    // parameters) and member names after a dot never count.
    private func HeaderIdentifiers(declaration FunctionDeclarationSyntax) HashSet[string] {
        var header = HeaderSpan(declaration)
        let identifiers = HashSet[string](StringComparer.Ordinal)
        for child in declaration.GetChildren() {
            if child is SyntaxToken || child.Span.Start < header.Start || child.Span.End > header.End {
                continue
            }
            CollectReferences(child, identifiers)
        }
        return identifiers
    }

    private func CollectReferences(node SyntaxNode?, identifiers HashSet[string]) {
        switch node {
            case SyntaxToken {
                // A token outside the shapes below names nothing an alias can
                // stand for (a declared name, a keyword, a member after `.`).
                return
            }
            case type is TypeClauseSyntax {
                // `Identifier` is the leftmost segment; the qualifier segments
                // after it are members of whatever it resolves to.
                AddName(type.Identifier, identifiers)
                CollectChildReferences(type, identifiers)
                for outer in type.OuterSegmentTypeArgumentChildren {
                    CollectReferences(outer, identifiers)
                }
                return
            }
            case typeParameter is TypeParameterSyntax {
                if typeParameter.ConstraintType != nil {
                    CollectReferences(typeParameter.ConstraintType, identifiers)
                } else {
                    AddName(typeParameter.Constraint, identifiers)
                    if typeParameter.ConstraintTypeArguments != nil {
                        for argument in typeParameter.ConstraintTypeArguments!! {
                            CollectReferences(argument, identifiers)
                        }
                    }
                }
                return
            }
            case annotation is AnnotationSyntax {
                if annotation.NameSegments.Length > 0 {
                    AddName(annotation.NameSegments[0], identifiers)
                }
                if annotation.TypeArguments != nil {
                    for argument in annotation.TypeArguments!! {
                        CollectReferences(argument, identifiers)
                    }
                }
                for argument in annotation.Arguments {
                    CollectReferences(argument, identifiers)
                }
                return
            }
            case accessor is AccessorExpressionSyntax {
                CollectReferences(accessor.LeftPart, identifiers)
                CollectMemberReferences(accessor.RightPart, identifiers)
                return
            }
            case name is NameExpressionSyntax {
                AddName(name.IdentifierToken, identifiers)
                return
            }
            case generic is GenericNameExpressionSyntax {
                AddName(generic.Identifier, identifiers)
                CollectReferences(generic.TypeArgumentList, identifiers)
                return
            }
            case call is CallExpressionSyntax {
                if call.Callee != nil {
                    CollectReferences(call.Callee, identifiers)
                } else {
                    AddName(call.Identifier, identifiers)
                }
                CollectCallParts(call, identifiers)
                return
            }
            case named is NamedArgumentExpressionSyntax {
                // The name before `:` is a parameter or property of the
                // attribute, not a reference.
                CollectReferences(named.Expression, identifiers)
                return
            }
            default {
                CollectChildReferences(node, identifiers)
                return
            }
        }
    }

    // The part after a `.`: its own name is a member, but its arguments and
    // type arguments are names of their own.
    private func CollectMemberReferences(member ExpressionSyntax?, identifiers HashSet[string]) {
        switch member {
            case NameExpressionSyntax {
                return
            }
            case generic is GenericNameExpressionSyntax {
                CollectReferences(generic.TypeArgumentList, identifiers)
                return
            }
            case call is CallExpressionSyntax {
                if call.Callee != nil {
                    CollectMemberReferences(call.Callee, identifiers)
                }
                CollectCallParts(call, identifiers)
                return
            }
            case accessor is AccessorExpressionSyntax {
                CollectMemberReferences(accessor.LeftPart, identifiers)
                CollectMemberReferences(accessor.RightPart, identifiers)
                return
            }
            default {
                CollectReferences(member, identifiers)
                return
            }
        }
    }

    private func CollectCallParts(call CallExpressionSyntax, identifiers HashSet[string]) {
        if call.ConversionTypeClause != nil {
            CollectReferences(call.ConversionTypeClause, identifiers)
        }
        if call.TypeArgumentList != nil {
            CollectReferences(call.TypeArgumentList, identifiers)
        }
        for argument in call.Arguments {
            CollectReferences(argument, identifiers)
        }
    }

    private func CollectChildReferences(node SyntaxNode?, identifiers HashSet[string]) {
        for child in node!!.GetChildren() {
            CollectReferences(child, identifiers)
        }
    }

    private func AddName(token SyntaxToken?, identifiers HashSet[string]) {
        if token != nil && token.Kind == SyntaxKind.IdentifierToken {
            identifiers.Add(token.ValueText)
        }
    }

    private func HeaderText(declaration FunctionDeclarationSyntax) string -> declaration
        .SyntaxTree
        .Text
        .ToString(HeaderSpan(declaration))

    // From the first modifier (or `func`) through the return type — or the
    // closing parenthesis of a function with none. Method-level annotations
    // precede it and the body or `;` follows it, so both are left alone.
    private func HeaderSpan(declaration FunctionDeclarationSyntax) TextSpan {
        var start = declaration.FunctionKeyword.Span.Start
        for child in declaration.GetChildren() {
            if child is AnnotationSyntax || child is BlockStatementSyntax {
                continue
            }
            if child.Span.Start < start {
                start = child.Span.Start
            }
        }
        var end = declaration.CloseParenthesisToken.Span.End
        if declaration.Type != nil && declaration.Type!!.Span.End > end {
            end = declaration.Type!!.Span.End
        }
        return TextSpan.FromBounds(start, end)
    }

    // The header's tokens as gsc's pairing check compares them
    // (PartialMethodMerger.TokenSignature): trivia between tokens is
    // ignored, but every token keeps its own text, so string defaults "a b"
    // and "a  b" differ. Built from the header's children in source order.
    private func HeaderSignature(declaration FunctionDeclarationSyntax) string {
        var header = HeaderSpan(declaration)
        let children = List[SyntaxNode]()
        for child in declaration.GetChildren() {
            if child.Span.Start >= header.Start && child.Span.End <= header.End && child.Span.Length > 0 {
                children.Add(child)
            }
        }
        let builder = StringBuilder()
        for child in children.OrderBy((node SyntaxNode) -> node.Span.Start) {
            builder.Append(PartialMethodMerger.TokenSignature(child))
        }
        return builder.ToString()
    }
}
