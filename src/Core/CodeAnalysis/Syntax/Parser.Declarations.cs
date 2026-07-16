// <copyright file="Parser.Declarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

public partial class Parser
{
    /// <summary>
    /// ADR-0078 / issue #718: detects whether the current parser position
    /// begins a Kotlin/Swift-style aggregate declaration head — optionally
    /// preceded by modifiers (open, sealed, data, inline, ref) — by scanning
    /// ahead to see if it terminates in one of <c>class</c>, <c>struct</c>,
    /// <c>enum</c>, or <c>interface</c>. The scan does not consume tokens.
    /// Returning false leaves dispatch to the legacy <c>type</c>-keyword path
    /// (which now only handles type aliases and named delegates).
    /// </summary>
    private bool TryDetectAggregateDeclarationHead()
    {
        return TryDetectAggregateDeclarationHead(0);
    }

    /// <summary>
    /// Issue #910: offset-aware variant of <see cref="TryDetectAggregateDeclarationHead()"/>
    /// used by the class/struct body member loop to recognise a nested type
    /// declaration head that may be preceded by an accessibility modifier
    /// (already peeked at <paramref name="startOffset"/>). The scan does not
    /// consume tokens.
    /// </summary>
    private bool TryDetectAggregateDeclarationHead(int startOffset)
    {
        var offset = startOffset;
        var saw = new HashSet<string>(System.StringComparer.Ordinal);
        while (true)
        {
            var k = Peek(offset);
            if (k.Kind == SyntaxKind.ClassKeyword ||
                k.Kind == SyntaxKind.StructKeyword ||
                k.Kind == SyntaxKind.EnumKeyword ||
                k.Kind == SyntaxKind.InterfaceKeyword)
            {
                return true;
            }

            if (k.Kind == SyntaxKind.OpenKeyword || k.Kind == SyntaxKind.SealedKeyword)
            {
                offset++;
                continue;
            }

            // ADR-0122 / issue #1202: `unsafe` composes with the other class
            // modifiers (in any order), establishing an unsafe context for the
            // whole aggregate. Treat it like the other contextual modifiers.
            if (k.Kind == SyntaxKind.IdentifierToken && (k.Text == "data" || k.Text == "inline" || k.Text == "ref" || k.Text == "unsafe" || k.Text == "partial"))
            {
                // Bail out if the same contextual modifier appears twice — we are
                // not in a declaration head; let the legacy / statement parser
                // surface the right diagnostic.
                if (!saw.Add(k.Text))
                {
                    return false;
                }

                offset++;
                continue;
            }

            return false;
        }
    }

    /// <summary>
    /// ADR-0078 / issue #718: parses an aggregate declaration whose head is
    ///   [open|sealed]? [data]? [inline]? [ref]? (class|struct|enum|interface) Name[TParams]? ...
    /// The accessibility modifier was already consumed in <see cref="ParseMember"/>.
    /// Issue #1602: depth-guarded — nested type declarations
    /// (<c>class A { class B { … } }</c>) recurse through this method.
    /// </summary>
    private MemberSyntax ParseAggregateDeclaration(SyntaxToken accessibilityModifier)
    {
        EnsureNestedParseAllowed();
        recursionDepth++;
        try
        {
            return ParseAggregateDeclarationCore(accessibilityModifier);
        }
        finally
        {
            recursionDepth--;
        }
    }

    private MemberSyntax ParseAggregateDeclarationCore(SyntaxToken accessibilityModifier)
    {
        SyntaxToken openModifier = null;
        SyntaxToken sealedModifier = null;
        SyntaxToken dataKeyword = null;
        SyntaxToken inlineKeyword = null;
        SyntaxToken refModifier = null;
        SyntaxToken unsafeModifier = null;
        SyntaxToken partialModifier = null;

        // Collect modifiers in any order. Re-issuing of a modifier is reported
        // as an unexpected token but parsing continues for recovery.
        while (true)
        {
            // ADR-0122 / issue #1202: `unsafe` composes with the other class
            // modifiers in any order (e.g. `unsafe open class`, `open unsafe
            // class`). It is a contextual identifier keyword.
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe")
            {
                if (unsafeModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                unsafeModifier = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.OpenKeyword)
            {
                if (openModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                openModifier = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.SealedKeyword)
            {
                if (sealedModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                sealedModifier = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
            {
                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                dataKeyword = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
            {
                if (inlineKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                inlineKeyword = NextToken();
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref")
            {
                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword);
                }

                refModifier = NextToken();
                continue;
            }

            // ADR-0144 / issue #2201: `partial` is a contextual modifier that
            // composes with the other aggregate modifiers in any order. It is
            // valid on class/struct/interface (rejected on enum below).
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "partial")
            {
                if (partialModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
                }

                partialModifier = NextToken();
                continue;
            }

            break;
        }

        // Combination rules (ADR-0078):
        //   - data + inline → GS0311
        //   - open + sealed → GS0312
        // The remaining kind-specific rules (open struct, sealed enum, inline
        // class, ...) are validated below once the aggregate keyword is known.
        if (dataKeyword != null && inlineKeyword != null)
        {
            Diagnostics.ReportDataAndInlineCannotCombine(inlineKeyword.Location);
        }

        if (openModifier != null && sealedModifier != null)
        {
            Diagnostics.ReportOpenAndSealedCannotCombine(sealedModifier.Location);
        }

        var aggregateKw = Current;
        var aggregateKind = aggregateKw.Kind;
        var aggregateText = aggregateKw.Text;

        if (aggregateKind != SyntaxKind.ClassKeyword &&
            aggregateKind != SyntaxKind.StructKeyword &&
            aggregateKind != SyntaxKind.EnumKeyword &&
            aggregateKind != SyntaxKind.InterfaceKeyword)
        {
            // Should not happen — TryDetectAggregateDeclarationHead already
            // verified the lookahead. Defensive recovery: emit and bail.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword);
            NextToken();
            return new GlobalStatementSyntax(syntaxTree, ParseStatement());
        }

        // Per-kind modifier validation.
        switch (aggregateKind)
        {
            case SyntaxKind.ClassKeyword:
                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.StructKeyword);
                }

                break;

            case SyntaxKind.StructKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (sealedModifier != null)
                {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText);
                }

                break;

            case SyntaxKind.EnumKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (sealedModifier != null)
                {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText);
                }

                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.EnumKeyword);
                }

                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.EnumKeyword);
                }

                if (unsafeModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(unsafeModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.EnumKeyword);
                }

                if (partialModifier != null)
                {
                    Diagnostics.ReportPartialNotValidOnKind(partialModifier.Location, "enum");
                }

                break;

            case SyntaxKind.InterfaceKeyword:
                if (openModifier != null)
                {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText);
                }

                if (dataKeyword != null)
                {
                    Diagnostics.ReportUnexpectedToken(dataKeyword.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
                }

                if (inlineKeyword != null)
                {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location);
                }

                if (refModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(refModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
                }

                if (unsafeModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(unsafeModifier.Location, SyntaxKind.IdentifierToken, SyntaxKind.InterfaceKeyword);
                }

                break;
        }

        // Consume the aggregate keyword and the identifier, then optional type
        // parameters: `class Name[TParams]?`.
        var aggregateKeyword = NextToken();
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        var typeParameterList = ParseOptionalTypeParameterList();

        if (aggregateKind == SyntaxKind.EnumKeyword)
        {
            // Note: the unified parser deliberately allows `enum` to fall
            // through to the inner enum production even when stray modifiers
            // were diagnosed above — recovery only.
            if (typeParameterList != null)
            {
                Diagnostics.ReportUnexpectedToken(typeParameterList.OpenBracketToken.Location, SyntaxKind.OpenSquareBracketToken, SyntaxKind.EnumKeyword);
            }

            return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier);
        }

        if (aggregateKind == SyntaxKind.InterfaceKeyword)
        {
            var interfaceDecl = ParseInterfaceDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier, typeParameterList);
            interfaceDecl.PartialModifier = partialModifier;
            return interfaceDecl;
        }

        // class / struct path.
        if (unsafeModifier != null)
        {
            this.unsafeDepth++;
        }

        try
        {
            var structDecl = ParseStructDeclarationNew(accessibilityModifier, dataKeyword, inlineKeyword, openModifier, sealedModifier, refModifier, aggregateKeyword, identifier);
            structDecl.TypeParameterList = typeParameterList;
            structDecl.RefModifier = refModifier;
            structDecl.UnsafeModifier = unsafeModifier;
            structDecl.PartialModifier = partialModifier;
            return structDecl;
        }
        finally
        {
            if (unsafeModifier != null)
            {
                this.unsafeDepth--;
            }
        }
    }

    /// <summary>
    /// ADR-0078: parses the body of a class or struct declaration whose
    /// modifiers, aggregate keyword, and identifier have already been consumed
    /// by <see cref="ParseAggregateDeclaration"/>. Delegates into the shared
    /// body parser by passing the aggregate keyword as preconsumed.
    /// </summary>
    private StructDeclarationSyntax ParseStructDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken sealedModifier,
        SyntaxToken refModifier,
        SyntaxToken aggregateKeyword,
        SyntaxToken identifier)
    {
        var decl = ParseStructDeclaration(
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            preconsumedStructOrClassKeyword: aggregateKeyword);
        decl.SealedKeyword = sealedModifier;
        return decl;
    }

    private MemberSyntax ParseEnumDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken enumKeyword,
        SyntaxToken identifier)
    {
        // The aggregate `enum` keyword is already consumed. Read the body
        // directly, since ParseEnumDeclaration assumes it still has to match
        // the keyword.
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var members = ParseEnumMembers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text);
        }

        // ADR-0078 / issue #725: if ANY enum member carries a payload, the
        // entire enum is a discriminated union. Desugar it at parse time into
        //   sealed class EnumName { }
        //   class Case1(params) : EnumName { ... }   // per case
        // Flat (non-payload) cases turn into an empty class with the same
        // base, so a uniform pattern-match works on every case.
        var hasAnyPayload = false;
        for (var i = 0; i < members.Count; i++)
        {
            if (members[i].HasPayload)
            {
                hasAnyPayload = true;
                break;
            }
        }

        if (hasAnyPayload)
        {
            return BuildDiscriminatedUnionDesugaring(accessibilityModifier, sealedModifier, enumKeyword, identifier, openBrace, members, closeBrace);
        }

        var decl = new EnumDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword: null, identifier, enumKeyword, openBrace, members, closeBrace);
        decl.SealedKeyword = sealedModifier;
        return decl;
    }

    private StructDeclarationSyntax BuildDiscriminatedUnionDesugaring(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken enumKeyword,
        SyntaxToken identifier,
        SyntaxToken openBrace,
        SeparatedSyntaxList<EnumMemberSyntax> members,
        SyntaxToken closeBrace)
    {
        // ADR-0078 / issue #725: synthesize `sealed class EnumName {}` as the
        // base, and queue `class CaseName[(params)] : EnumName { }` per case.
        // The Parser.pendingSyntheticMembers queue is drained after the
        // current ParseMember call returns, so the synthetic classes appear
        // immediately after the base in declaration order.
        var classKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, enumKeyword.Position, "class", null);
        var effectiveSealed = sealedModifier ?? new SyntaxToken(syntaxTree, SyntaxKind.SealedKeyword, enumKeyword.Position, "sealed", null);

        var baseDecl = new StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            dataKeyword: null,
            inlineKeyword: null,
            openModifier: null,
            structKeyword: classKeyword,
            primaryConstructorOpenParen: null,
            primaryConstructorParameters: new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty),
            primaryConstructorCloseParen: null,
            baseColonToken: null,
            baseTypeIdentifier: null,
            additionalBaseTypeIdentifiers: ImmutableArray<SyntaxToken>.Empty,
            openBraceToken: openBrace,
            fields: ImmutableArray<FieldDeclarationSyntax>.Empty,
            properties: ImmutableArray<PropertyDeclarationSyntax>.Empty,
            events: ImmutableArray<EventDeclarationSyntax>.Empty,
            methods: ImmutableArray<FunctionDeclarationSyntax>.Empty,
            closeBraceToken: closeBrace);
        baseDecl.SealedKeyword = effectiveSealed;

        for (var i = 0; i < members.Count; i++)
        {
            var member = members[i];
            var caseClassKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, member.Identifier.Position, "class", null);
            var colon = new SyntaxToken(syntaxTree, SyntaxKind.ColonToken, member.Identifier.Position, ":", null);

            var primaryOpen = member.HasPayload ? member.PayloadOpenParenthesis : null;
            var primaryClose = member.HasPayload ? member.PayloadCloseParenthesis : null;
            var primaryParams = member.HasPayload
                ? member.PayloadParameters
                : new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);

            var caseDecl = new StructDeclarationSyntax(
                syntaxTree,
                accessibilityModifier: null,
                typeKeyword: null,
                member.Identifier,
                dataKeyword: null,
                inlineKeyword: null,
                openModifier: null,
                structKeyword: caseClassKeyword,
                primaryConstructorOpenParen: primaryOpen,
                primaryConstructorParameters: primaryParams,
                primaryConstructorCloseParen: primaryClose,
                baseColonToken: colon,
                baseTypeIdentifier: identifier,
                additionalBaseTypeIdentifiers: ImmutableArray<SyntaxToken>.Empty,
                openBraceToken: openBrace,
                fields: ImmutableArray<FieldDeclarationSyntax>.Empty,
                properties: ImmutableArray<PropertyDeclarationSyntax>.Empty,
                events: ImmutableArray<EventDeclarationSyntax>.Empty,
                methods: ImmutableArray<FunctionDeclarationSyntax>.Empty,
                closeBraceToken: closeBrace);

            var baseTypeClause = new TypeClauseSyntax(syntaxTree, identifier);
            caseDecl.BaseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray.Create<SyntaxNode>(baseTypeClause));

            pendingSyntheticMembers.Enqueue(caseDecl);
        }

        return baseDecl;
    }

    private InterfaceDeclarationSyntax ParseInterfaceDeclarationNew(
        SyntaxToken accessibilityModifier,
        SyntaxToken sealedModifier,
        SyntaxToken interfaceKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList)
    {
        // The aggregate `interface` keyword is already consumed. Build the
        // body by hand (mirroring ParseInterfaceDeclaration but without the
        // up-front MatchToken on the keyword).
        //
        // Issue #1006: an interface may declare one or more base interfaces via
        // a `: A, B` clause directly after the identifier / type-parameter list,
        // mirroring `interface B : A` in C#. Reuse the same comma-separated
        // type-clause parsing the class/struct path uses; the binder enforces
        // that every entry resolves to an interface.
        SyntaxToken baseColon = null;
        var baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            var firstBaseType = ParseTypeClause();
            baseTypeClauseNodesAndSeparators.Add(firstBaseType);

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                baseTypeClauseNodesAndSeparators.Add(comma);
                var nextType = ParseTypeClause();
                baseTypeClauseNodesAndSeparators.Add(nextType);
            }

            baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(baseTypeClauseNodesAndSeparators.ToImmutable());
        }

        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var staticFields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var seenSharedBlock = false;
        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Issue #2129: interface members accept Kotlin-style @annotations
            // (ADR-0047) exactly like class/struct members. Parse the leading
            // annotation list once and attach it to whichever member follows —
            // property, event, or method signature — mirroring how ParseMember
            // threads annotations onto class members.
            var annotations = ParseAnnotations();

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // Issue #865 revision: static-virtual members live in a
                // `shared { … }` block (ADR-0089), consistent with classes/structs.
                ParseInterfaceSharedBlock(methods, properties, staticFields, ref seenSharedBlock, identifier.Text);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                properties.Add(ParsePropertyDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null).WithAnnotations(annotations));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                events.Add(ParseEventDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null).WithAnnotations(annotations));
            }
            else if (IsInterfaceMethodSignatureStart())
            {
                methods.Add((FunctionDeclarationSyntax)ParseInterfaceMethodSignature().WithAnnotations(annotations));
            }
            else
            {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword);
                NextToken();
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        var interfaceDecl = new InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: null,
            identifier,
            typeParameterList,
            sealedModifier,
            interfaceKeyword,
            openBrace,
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace);
        interfaceDecl.BaseColonToken = baseColon;
        interfaceDecl.BaseTypeClauses = baseTypeClauses;
        interfaceDecl.StaticFields = staticFields.ToImmutable();
        return interfaceDecl;
    }

    private MemberSyntax ParseTypeAliasDeclaration(SyntaxToken accessibilityModifier)
    {
        var typeKeyword = MatchToken(SyntaxKind.TypeKeyword);
        var identifier = MatchToken(SyntaxKind.IdentifierToken);

        // Phase 4.3 / ADR-0020: optional type-parameter list directly after the
        // type name: `type Box[T any] = ...`. Reuses the same helpers as
        // generic function declarations.
        var typeParameterList = ParseOptionalTypeParameterList();

        // ADR-0078 / issue #718: the only valid uses of the `type` keyword are
        //   `type Name [TParams]? = SomeType`          — erased type alias
        //   `type Name [TParams]? = delegate func(...)` — named CLR delegate
        // Anything else here is a legacy aggregate declaration (`class Name
        // { … }`, `data class Name { … }`, `data struct Name { … }`, …)
        // and must be rejected with GS0306 / GS0307 plus a migration snippet.
        if (Current.Kind != SyntaxKind.EqualsToken)
        {
            return ReportAndRecoverLegacyAggregateForm(accessibilityModifier, typeKeyword, identifier, typeParameterList);
        }

        var equalsToken = MatchToken(SyntaxKind.EqualsToken);

        // ADR-0059 / issue #255: `type Name [TParams] = delegate func(...) R`
        // declares a named CLR delegate type. The `delegate` contextual keyword
        // (an IdentifierToken whose text is "delegate") differentiates this
        // case from the erased type-alias form below. We require `func` to
        // immediately follow `delegate`; anything else trips GS0233.
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "delegate")
        {
            return ParseDelegateDeclaration(accessibilityModifier, typeKeyword, identifier, typeParameterList, equalsToken);
        }

        var aliasedIdentifier = MatchToken(SyntaxKind.IdentifierToken);
        var aliasedType = new TypeClauseSyntax(syntaxTree, aliasedIdentifier);
        return new TypeAliasDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword, identifier, equalsToken, aliasedType);
    }

    /// <summary>
    /// ADR-0078 / issue #718: emit GS0306 (or GS0307 for <c>record</c>) on a
    /// legacy aggregate declaration head (<c>type Name [mods]? &lt;kind&gt; ...</c>)
    /// and recover by consuming the modifier/keyword/body sequence as if the
    /// declaration had been written in the new grammar. The recovered syntax
    /// node feeds the rest of the pipeline so that downstream tests see one
    /// high-quality diagnostic instead of a cascade.
    /// </summary>
    private MemberSyntax ReportAndRecoverLegacyAggregateForm(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList)
    {
        // Collect any legacy modifiers in their original order so the migration
        // suggestion preserves the spelling the user typed.
        var seenSpellings = new List<string>();
        SyntaxToken openModifier = null;
        SyntaxToken sealedModifier = null;
        SyntaxToken dataKeyword = null;
        SyntaxToken inlineKeyword = null;
        SyntaxToken refModifier = null;
        SyntaxToken recordKeyword = null;
        var hadRecord = false;

        while (true)
        {
            if (Current.Kind == SyntaxKind.OpenKeyword)
            {
                openModifier = NextToken();
                seenSpellings.Add("open");
                continue;
            }

            if (Current.Kind == SyntaxKind.SealedKeyword)
            {
                sealedModifier = NextToken();
                seenSpellings.Add("sealed");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data")
            {
                dataKeyword = NextToken();
                seenSpellings.Add("data");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline")
            {
                inlineKeyword = NextToken();
                seenSpellings.Add("inline");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref")
            {
                refModifier = NextToken();
                seenSpellings.Add("ref");
                continue;
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record")
            {
                recordKeyword = NextToken();
                hadRecord = true;
                continue;
            }

            break;
        }

        SyntaxToken aggregateKeyword = null;
        string kindText = null;

        if (hadRecord)
        {
            // `record` becomes `data class` in the new spelling (ref-typed
            // equality-bearing aggregate). We synthesise the class keyword so
            // recovery can run the class-body parser.
            kindText = "data class";
            aggregateKeyword = new SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, recordKeyword.Position, "class", null);
            if (dataKeyword == null)
            {
                dataKeyword = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordKeyword.Position, "data", null);
            }

            Diagnostics.ReportRecordKeywordRemoved(typeKeyword.Location, identifier.Text);
        }
        else if (Current.Kind == SyntaxKind.ClassKeyword ||
                 Current.Kind == SyntaxKind.StructKeyword ||
                 Current.Kind == SyntaxKind.EnumKeyword ||
                 Current.Kind == SyntaxKind.InterfaceKeyword)
        {
            aggregateKeyword = NextToken();
            kindText = aggregateKeyword.Text;

            var modifierSpelling = seenSpellings.Count == 0 ? string.Empty : string.Join(' ', seenSpellings) + " ";
            var typeParamSuffix = typeParameterList == null
                ? string.Empty
                : RenderTypeParameterList(typeParameterList);
            var migration = $"{modifierSpelling}{kindText} {identifier.Text}{typeParamSuffix}";
            Diagnostics.ReportOldTypeDeclarationFormRemoved(typeKeyword.Location, migration);
        }
        else
        {
            // No `=` AND no aggregate keyword: probably a malformed alias.
            // Emit a generic unexpected-token diagnostic and stop.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.EqualsToken);
            return new TypeAliasDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                typeKeyword,
                identifier,
                new SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, Current.Position, "=", null),
                new TypeClauseSyntax(syntaxTree, new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, Current.Position, identifier.Text, null)));
        }

        // Recover by feeding the synthesised modifiers + aggregate keyword
        // into the new-grammar aggregate parser so the rest of the file can
        // still be analysed.
        switch (aggregateKeyword.Kind)
        {
            case SyntaxKind.EnumKeyword:
                {
                    if (typeParameterList != null)
                    {
                        Diagnostics.ReportUnexpectedToken(typeParameterList.OpenBracketToken.Location, SyntaxKind.OpenSquareBracketToken, SyntaxKind.EnumKeyword);
                    }

                    return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier);
                }

            case SyntaxKind.InterfaceKeyword:
                return ParseInterfaceDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier, typeParameterList);

            default:
                {
                    var structDecl = ParseStructDeclarationNew(accessibilityModifier, dataKeyword, inlineKeyword, openModifier, sealedModifier, refModifier, aggregateKeyword, identifier);
                    structDecl.TypeParameterList = typeParameterList;
                    structDecl.RefModifier = refModifier;
                    return structDecl;
                }
        }
    }

    /// <summary>
    /// ADR-0078 / issue #718: recover from the removed standalone <c>record</c>
    /// keyword at member position. Emits GS0307 and parses the rest of the
    /// declaration as if the user had written <c>data struct Name ...</c>.
    /// </summary>
    private MemberSyntax ReportAndRecoverLegacyRecordHead(SyntaxToken accessibilityModifier)
    {
        var recordToken = NextToken();
        var identifier = MatchToken(SyntaxKind.IdentifierToken);
        Diagnostics.ReportRecordKeywordRemoved(recordToken.Location, identifier.Text);

        // Recover by parsing the body as a `data struct Name ...` so downstream
        // analysis can still proceed against the (renamed) declaration.
        var syntheticData = new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordToken.Position, "data", null);
        var syntheticStruct = new SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, recordToken.Position, "struct", null);
        return ParseStructDeclarationNew(
            accessibilityModifier,
            dataKeyword: syntheticData,
            inlineKeyword: null,
            openModifier: null,
            sealedModifier: null,
            refModifier: null,
            aggregateKeyword: syntheticStruct,
            identifier: identifier);
    }

    private static string RenderTypeParameterList(TypeParameterListSyntax list)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append('[');
        var first = true;
        foreach (var p in list.Parameters)
        {
            if (!first)
            {
                sb.Append(", ");
            }

            sb.Append(p.Identifier.Text);
            if (p.Constraint != null)
            {
                sb.Append(' ');
                sb.Append(p.Constraint.Text);
            }

            first = false;
        }

        sb.Append(']');
        return sb.ToString();
    }

    private MemberSyntax ParseDelegateDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        TypeParameterListSyntax typeParameterList,
        SyntaxToken equalsToken)
    {
        // `delegate` is a contextual keyword that stays as an IdentifierToken
        // — mirrors the existing data/record/inline/ref contextual-modifier
        // handling in ParseTypeAliasDeclaration. We DO NOT promote it to a
        // dedicated SyntaxKind because that would force adding it to
        // SyntaxFacts.GetKeywordKind, breaking any future use of `delegate`
        // as a plain identifier.
        var delegateKeyword = NextToken();

        if (Current.Kind != SyntaxKind.FuncKeyword)
        {
            Diagnostics.ReportDelegateDeclarationRequiresFunc(Current.Location);
        }

        var funcKeyword = MatchToken(SyntaxKind.FuncKeyword);
        var openParen = MatchToken(SyntaxKind.OpenParenthesisToken);
        var parameters = ParseParameterList();
        var closeParen = MatchToken(SyntaxKind.CloseParenthesisToken);

        // Return type clause is optional; absence means `void` per the existing
        // `func` declaration convention.
        TypeClauseSyntax returnType = null;
        if (CanStartTypeClause(Current))
        {
            returnType = ParseTypeClause();
        }

        return new DelegateDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            typeParameterList,
            equalsToken,
            delegateKeyword,
            funcKeyword,
            openParen,
            parameters,
            closeParen,
            returnType);
    }

    /// <summary>
    /// Returns true when <paramref name="token"/> can start a TypeClauseSyntax.
    /// Used by the delegate declaration parser to decide whether the optional
    /// return type clause is present.
    /// </summary>
    private static bool CanStartTypeClause(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.FuncKeyword:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.MapKeyword:
            case SyntaxKind.ChanKeyword:
            case SyntaxKind.SequenceKeyword:
            case SyntaxKind.AsyncKeyword:
            case SyntaxKind.StarToken:
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// Issue #490: returns true when <paramref name="token"/> can plausibly begin an expression
    /// — used by <see cref="ParseReturnStatement"/> to disambiguate the contextual <c>ref</c>
    /// modifier from an identifier expression named <c>ref</c>.
    /// </summary>
    private static bool CanStartExpression(SyntaxToken token)
    {
        switch (token.Kind)
        {
            case SyntaxKind.IdentifierToken:
            case SyntaxKind.NumberToken:
            case SyntaxKind.StringToken:
            case SyntaxKind.OpenParenthesisToken:
            case SyntaxKind.OpenSquareBracketToken:
            case SyntaxKind.AmpersandToken:
            case SyntaxKind.StarToken:
            case SyntaxKind.MinusToken:
            case SyntaxKind.PlusToken:
            case SyntaxKind.BangToken:
            case SyntaxKind.TrueKeyword:
            case SyntaxKind.FalseKeyword:
            case SyntaxKind.NilKeyword:
            case SyntaxKind.FuncKeyword:
                return true;
            default:
                return false;
        }
    }

    private EnumDeclarationSyntax ParseEnumDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier)
    {
        var enumKeyword = MatchToken(SyntaxKind.EnumKeyword);
        var openBrace = MatchToken(SyntaxKind.OpenBraceToken);
        var members = ParseEnumMembers();
        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);

        if (members.Count == 0)
        {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text);
        }

        return new EnumDeclarationSyntax(syntaxTree, accessibilityModifier, typeKeyword, identifier, enumKeyword, openBrace, members, closeBrace);
    }

    private SeparatedSyntaxList<EnumMemberSyntax> ParseEnumMembers()
    {
        var nodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken;
        while (parseNext &&
               Current.Kind != SyntaxKind.CloseBraceToken &&
               Current.Kind != SyntaxKind.EndOfFileToken)
        {
            // Issue #188 / ADR-0047 §3: each enum-member entry may be
            // preceded by Kotlin-style `@Foo` annotations (default target
            // `field`, since enum members are emitted as static literal
            // fields on the enum type per ECMA-335 §I.8.5.2).
            var annotations = ParseAnnotations();
            var identifier = MatchToken(SyntaxKind.IdentifierToken);
            var member = new EnumMemberSyntax(syntaxTree, identifier).WithAnnotations(annotations);

            // ADR-0078 / issue #725: discriminated-union enum case may carry
            // a payload as a primary-constructor parameter list:
            //   enum Shape { Circle(r float64); Square(s float64) }
            // We accept either `;` or `,` between cases — `;` is the canonical
            // separator when payloads are present.
            if (Current.Kind == SyntaxKind.OpenParenthesisToken)
            {
                member.PayloadOpenParenthesis = MatchToken(SyntaxKind.OpenParenthesisToken);
                member.PayloadParameters = ParseParameterList();
                member.PayloadCloseParenthesis = MatchToken(SyntaxKind.CloseParenthesisToken);
            }

            // Issue #1912: an enum member may carry an explicit constant value,
            // e.g. `Banana = 2` or `DefaultError = ServerError`. The binder
            // restricts this to a constant-foldable int32 expression (literals,
            // unary +/-/~, +, -, |, &, ^, <<, >>, and references to already-declared
            // sibling members); anything else is a binder-level diagnostic.
            if (Current.Kind == SyntaxKind.EqualsToken)
            {
                member.EqualsToken = MatchToken(SyntaxKind.EqualsToken);
                member.Value = ParseBinaryExpression();
            }

            nodesAndSeparators.Add(member);

            if (Current.Kind == SyntaxKind.CommaToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken));
            }
            else if (Current.Kind == SyntaxKind.SemicolonToken)
            {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.SemicolonToken));
            }
            else
            {
                parseNext = false;
            }
        }

        return new SeparatedSyntaxList<EnumMemberSyntax>(nodesAndSeparators.ToImmutable());
    }

    /// <summary>
    /// Issue #296: matches a base-type name that may be fully qualified
    /// (e.g. <c>System.IO.MemoryStream</c>). The dotted segments are folded
    /// into a single <see cref="SyntaxKind.IdentifierToken"/> whose text is the
    /// dotted name, so the binder resolves it via the imported/alias-aware type
    /// resolution path. A bare identifier (e.g. <c>MemoryStream</c>) is returned
    /// unchanged.
    /// </summary>
    private SyntaxToken MatchQualifiedTypeName()
    {
        var first = MatchToken(SyntaxKind.IdentifierToken);
        if (Current.Kind != SyntaxKind.DotToken || Peek(1).Kind != SyntaxKind.IdentifierToken)
        {
            return first;
        }

        var text = first.Text;
        while (Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            NextToken();
            var segment = MatchToken(SyntaxKind.IdentifierToken);
            text += "." + segment.Text;
        }

        return new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, first.Position, text, null);
    }

    private StructDeclarationSyntax ParseStructDeclaration(
        SyntaxToken accessibilityModifier,
        SyntaxToken typeKeyword,
        SyntaxToken identifier,
        SyntaxToken dataKeyword,
        SyntaxToken inlineKeyword,
        SyntaxToken openModifier,
        SyntaxToken preconsumedStructOrClassKeyword = null)
    {
        var structOrClassKeyword = preconsumedStructOrClassKeyword ?? (Current.Kind == SyntaxKind.ClassKeyword
            ? MatchToken(SyntaxKind.ClassKeyword)
            : MatchToken(SyntaxKind.StructKeyword));

        // Modifier validation (inline only on struct, open only on class, data
        // combination rules) is now performed in the caller — either
        // ParseAggregateDeclaration (new grammar, ADR-0078) or
        // ParseTypeAliasDeclaration (legacy grammar, GS0306).

        // Phase 3.B.3 sub-step 2: optional Kotlin-style primary constructor
        // parameter list `(name Type, name Type, ...)` directly after the
        // `class` keyword. Each parameter becomes both a ctor argument and a
        // public field of the same name. Both classes and structs accept a
        // primary constructor parameter list.
        SyntaxToken primaryCtorOpenParen = null;
        SyntaxToken primaryCtorCloseParen = null;
        SeparatedSyntaxList<ParameterSyntax> primaryCtorParameters = new SeparatedSyntaxList<ParameterSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.OpenParenthesisToken)
        {
            primaryCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
            primaryCtorParameters = ParseParameterList();
            primaryCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
        }

        // Phase 3.B.3 sub-step 3: optional base clause `: Base`.
        // Phase 3.B.4 extends this to `: Base, IFoo, IBar` — a comma-separated
        // list. The binder classifies each identifier as either the base class
        // (at most one, must come first) or an implemented interface.
        // ADR-0078: structs may carry an implemented-interface clause too;
        // earlier parser-level restrictions are dropped (binder enforces
        // semantic legality, e.g. structs may not have a base class).
        SyntaxToken baseColon = null;
        SyntaxToken baseTypeIdentifier = null;
        SyntaxToken baseCtorOpenParen = null;
        SeparatedSyntaxList<ExpressionSyntax> baseCtorArguments = new SeparatedSyntaxList<ExpressionSyntax>(ImmutableArray<SyntaxNode>.Empty);
        SyntaxToken baseCtorCloseParen = null;
        var additionalBaseIdentifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
        var baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder<SyntaxNode>();
        var baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(ImmutableArray<SyntaxNode>.Empty);
        if (Current.Kind == SyntaxKind.ColonToken)
        {
            baseColon = MatchToken(SyntaxKind.ColonToken);
            var firstBaseType = ParseTypeClause();
            baseTypeClauseNodesAndSeparators.Add(firstBaseType);
            baseTypeIdentifier = firstBaseType.DottedName == null
                ? null
                : new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, firstBaseType.Identifier.Position, firstBaseType.DottedName, null);

            // Issue #306: optional base-constructor argument list immediately
            // after the base-class name, e.g. `: Exception(message)`. Only the
            // base class (the first identifier) may carry constructor arguments;
            // interfaces never do. The arguments are bound against the base
            // class's constructors and forwarded by the derived ctor.
            if (Current.Kind == SyntaxKind.OpenParenthesisToken)
            {
                baseCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken);
                baseCtorArguments = ParseArguments();
                baseCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken);
            }

            while (Current.Kind == SyntaxKind.CommaToken)
            {
                var comma = MatchToken(SyntaxKind.CommaToken);
                baseTypeClauseNodesAndSeparators.Add(comma);
                var nextType = ParseTypeClause();
                baseTypeClauseNodesAndSeparators.Add(nextType);
                var next = nextType.DottedName == null
                    ? null
                    : new SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, nextType.Identifier.Position, nextType.DottedName, null);
                additionalBaseIdentifiers.Add(next);
            }

            baseTypeClauses = new SeparatedSyntaxList<TypeClauseSyntax>(baseTypeClauseNodesAndSeparators.ToImmutable());
        }

        SyntaxToken openBrace;
        var fields = ImmutableArray.CreateBuilder<FieldDeclarationSyntax>();
        var properties = ImmutableArray.CreateBuilder<PropertyDeclarationSyntax>();
        var events = ImmutableArray.CreateBuilder<EventDeclarationSyntax>();
        var methods = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>();
        var constructors = ImmutableArray.CreateBuilder<ConstructorDeclarationSyntax>();
        DeinitDeclarationSyntax structDecl_deinit = null;
        SharedBlockSyntax structDecl_sharedBlock = null;
        var nestedTypes = ImmutableArray.CreateBuilder<MemberSyntax>();

        // ADR-0078 / issue #718: the body block `{ ... }` is optional for any
        // aggregate that uses the new declaration head. The bodyless form is
        //   class Name(params) [: Bases]
        //   struct Name(params) [: Bases]
        //   data class Name(params) [: Bases]
        //   data struct Name(params) [: Bases]
        //   inline struct Name(params)
        // — all of which carry their fields via the primary constructor. A
        // bodyless declaration is detected when the next token after the
        // declaration head is not <c>{</c>.
        var isBodyless = Current.Kind != SyntaxKind.OpenBraceToken;
        if (isBodyless)
        {
            openBrace = new SyntaxToken(syntaxTree, SyntaxKind.OpenBraceToken, Current.Position, "{", null);
            var syntheticCloseBrace = new SyntaxToken(syntaxTree, SyntaxKind.CloseBraceToken, Current.Position, "}", null);
            var bodylessDecl = new StructDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                typeKeyword,
                identifier,
                dataKeyword,
                inlineKeyword,
                openModifier,
                structOrClassKeyword,
                primaryCtorOpenParen,
                primaryCtorParameters,
                primaryCtorCloseParen,
                baseColon,
                baseTypeIdentifier,
                additionalBaseIdentifiers.ToImmutable(),
                openBrace,
                fields.ToImmutable(),
                properties.ToImmutable(),
                events.ToImmutable(),
                methods.ToImmutable(),
                syntheticCloseBrace);
            bodylessDecl.BaseTypeClauses = baseTypeClauses;
            bodylessDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen;
            bodylessDecl.BaseConstructorArguments = baseCtorArguments;
            bodylessDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen;
            return bodylessDecl;
        }

        openBrace = MatchToken(SyntaxKind.OpenBraceToken);

        while (Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            // Issue #186 / ADR-0047 §3: each struct/class body member may be
            // preceded by Kotlin-style `@Foo` annotations. For field members
            // the default target is `field`; for method members the existing
            // method-binder path picks them up via MemberSyntax.Annotations.
            var memberAnnotations = ParseAnnotations();

            // Issue #910 / ADR-0110: nested type declarations (class / struct /
            // interface / enum) inside a class or struct body. The declaration
            // head may be preceded by an optional accessibility modifier. Reuse
            // the shared top-level aggregate parser so nested types accept the
            // full declaration grammar (modifiers, type parameters, base
            // clauses, bodies, and recursive nesting).
            {
                var nestedHeadOffset = (Current.Kind == SyntaxKind.PublicKeyword
                    || Current.Kind == SyntaxKind.InternalKeyword
                    || Current.Kind == SyntaxKind.PrivateKeyword
                    || Current.Kind == SyntaxKind.ProtectedKeyword) ? 1 : 0;

                if (TryDetectAggregateDeclarationHead(nestedHeadOffset))
                {
                    SyntaxToken nestedAccessibility = null;
                    if (nestedHeadOffset == 1)
                    {
                        nestedAccessibility = NextToken();
                    }

                    var nestedType = ParseAggregateDeclaration(nestedAccessibility);
                    nestedType.WithAnnotations(memberAnnotations);
                    nestedTypes.Add(nestedType);

                    // A nested discriminated-union enum desugars into a sealed
                    // base plus one class per case (queued on
                    // pendingSyntheticMembers). Drain them as siblings of the
                    // nested type so they remain nested within this body.
                    while (pendingSyntheticMembers.Count > 0)
                    {
                        nestedTypes.Add(pendingSyntheticMembers.Dequeue());
                    }

                    if (Current == startToken)
                    {
                        NextToken();
                    }

                    continue;
                }
            }

            // Phase 3.B.3 sub-step 2b: method declarations inside the body.
            // Use the existing `func Name(args) Ret { body }` parser; the
            // method has no explicit receiver clause — the receiver is the
            // enclosing class. Struct types reject methods (diagnose+skip).
            SyntaxToken memberAccessibility = null;
            if (Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind.ProtectedKeyword)
            {
                // Accessibility modifier may be followed by an optional
                // `open`/`override` and an optional `async` (only meaningful
                // before `func`), then `func`, `prop`, or `event`.
                var ahead = 1;
                while (Peek(ahead).Kind == SyntaxKind.OpenKeyword || Peek(ahead).Kind == SyntaxKind.OverrideKeyword)
                {
                    ahead++;
                }

                if (Peek(ahead).Kind == SyntaxKind.AsyncKeyword && Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword)
                {
                    ahead++;
                }

                if (Peek(ahead).Kind == SyntaxKind.FuncKeyword ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "prop") ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "event") ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "init" && Peek(ahead + 1).Kind == SyntaxKind.OpenParenthesisToken) ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "convenience"
                        && ((Peek(ahead + 1).Kind == SyntaxKind.IdentifierToken && Peek(ahead + 1).Text == "init" && Peek(ahead + 2).Kind == SyntaxKind.OpenParenthesisToken)
                            || (Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword
                                && Peek(ahead + 2).Kind == SyntaxKind.IdentifierToken && Peek(ahead + 2).Text == "init"
                                && Peek(ahead + 3).Kind == SyntaxKind.OpenParenthesisToken))))
                {
                    memberAccessibility = NextToken();
                }
            }

            // Phase 3.B.3 sub-step 3: parse optional `open` / `override`
            // modifiers (any order) before the method's `func` keyword.
            SyntaxToken memberOpenModifier = null;
            SyntaxToken memberOverrideModifier = null;
            while (Current.Kind == SyntaxKind.OpenKeyword || Current.Kind == SyntaxKind.OverrideKeyword)
            {
                if (Current.Kind == SyntaxKind.OpenKeyword && memberOpenModifier == null)
                {
                    memberOpenModifier = NextToken();
                }
                else if (Current.Kind == SyntaxKind.OverrideKeyword && memberOverrideModifier == null)
                {
                    memberOverrideModifier = NextToken();
                }
                else
                {
                    // Duplicate modifier — diagnose by consuming and reporting.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword);
                    NextToken();
                }
            }

            // Issue #502 / ADR-0023: an optional `async` modifier may precede
            // `func` on a class instance method, mirroring the top-level path
            // in ParseMember. The modifier is consumed only when immediately
            // followed by `func`; otherwise it is left for ParseFieldDeclaration
            // (or another fallback) to surface a diagnostic.
            SyntaxToken memberAsyncModifier = null;
            if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
            {
                memberAsyncModifier = NextToken();
            }

            // ADR-0122 / issue #1014: optional `unsafe` contextual modifier on
            // an in-body `func` method. Consumed only when immediately followed
            // by `func` (or `async func`).
            SyntaxToken memberUnsafeModifier = null;
            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
                && (Peek(1).Kind == SyntaxKind.FuncKeyword || Peek(1).Kind == SyntaxKind.AsyncKeyword))
            {
                memberUnsafeModifier = NextToken();
                if (memberAsyncModifier == null && Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
                {
                    memberAsyncModifier = NextToken();
                }
            }

            // ADR-0065 §2: optional `convenience` contextual keyword may
            // precede `init` (or `func init`) on a class constructor.
            SyntaxToken memberConvenienceModifier = null;
            if (Current.Kind == SyntaxKind.IdentifierToken
                && Current.Text == "convenience"
                && ((Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
                    || (Peek(1).Kind == SyntaxKind.FuncKeyword
                        && Peek(2).Kind == SyntaxKind.IdentifierToken && Peek(2).Text == "init"
                        && Peek(3).Kind == SyntaxKind.OpenParenthesisToken)))
            {
                memberConvenienceModifier = NextToken();
            }

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(1).Kind == SyntaxKind.OpenParenthesisToken)
            {
                // Issue #306: standalone user-defined constructor
                // `init(params) [: base(args)] { body }`. Only valid for classes.
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                }

                var constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier);
                constructor.WithAnnotations(memberAnnotations);
                constructors.Add(constructor);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "deinit"
                     && (Peek(1).Kind == SyntaxKind.OpenBraceToken
                         || Peek(1).Kind == SyntaxKind.OpenParenthesisToken
                         || (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.OpenBraceToken)))
            {
                // ADR-0068 / issue #698: `deinit { … }` destructor declaration.
                // The keyword is a contextual identifier — we recognise it only
                // when it is immediately followed by `{` (well-formed case) or
                // by `(` (a malformed parameter-list shape we still want to
                // diagnose, not silently treat as a field).
                if (memberAccessibility != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAccessibility.Location, memberAccessibility.Kind, SyntaxKind.IdentifierToken);
                }

                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.IdentifierToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.IdentifierToken);
                }

                if (memberConvenienceModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberConvenienceModifier.Location, memberConvenienceModifier.Kind, SyntaxKind.IdentifierToken);
                }

                var deinitDecl = ParseDeinitDeclaration();
                deinitDecl.WithAnnotations(memberAnnotations);

                if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                {
                    Diagnostics.ReportDeinitOnNonClass(deinitDecl.DeinitKeyword.Location, identifier.Text ?? string.Empty, structOrClassKeyword.Kind);
                }

                if (structDecl_deinit != null)
                {
                    Diagnostics.ReportDuplicateDeinit(deinitDecl.DeinitKeyword.Location, identifier.Text ?? string.Empty);
                }
                else
                {
                    structDecl_deinit = deinitDecl;
                }
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                // ADR-0051: property declaration inside struct/class body.
                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var property = ParsePropertyDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier);
                property.WithAnnotations(memberAnnotations);
                properties.Add(property);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var eventDecl = ParseEventDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier);
                eventDecl.WithAnnotations(memberAnnotations);
                events.Add(eventDecl);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // ADR-0053: shared block grouping static member declarations.
                if (memberAccessibility != null || memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberAccessibility ?? memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.IdentifierToken, SyntaxKind.OpenBraceToken);
                }

                if (memberAsyncModifier != null)
                {
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                var sharedBlock = ParseSharedBlock();
                if (structDecl_sharedBlock != null)
                {
                    Diagnostics.ReportDuplicateSharedBlock(sharedBlock.SharedKeyword.Location);
                }
                else
                {
                    structDecl_sharedBlock = sharedBlock;
                }
            }
            else if (Current.Kind == SyntaxKind.FuncKeyword)
            {
                // Issue #656 / ADR-0065: `func init(...)` is accepted as an
                // alternative spelling of the constructor declaration. The
                // `func` keyword is consumed and the remainder is parsed as
                // a normal `init(...)` constructor.
                if (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(2).Kind == SyntaxKind.OpenParenthesisToken)
                {
                    NextToken(); // consume the `func` keyword

                    if (memberOpenModifier != null || memberOverrideModifier != null)
                    {
                        var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                        Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken);
                    }

                    if (memberAsyncModifier != null)
                    {
                        Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                    }

                    if (structOrClassKeyword.Kind != SyntaxKind.ClassKeyword)
                    {
                        Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken);
                    }

                    var constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier);
                    constructor.WithAnnotations(memberAnnotations);
                    constructors.Add(constructor);
                }
                else
                {
                    // Issue #938 / ADR-0079: in-body `func` instance methods are
                    // the canonical declaration site for owned `class` AND owned
                    // `struct`/`data struct` types. Both aggregate kinds accept
                    // the member here; the binder records it as an instance
                    // method on the receiver type (by-ref `this` for value types).
                    FunctionDeclarationSyntax method;
                    if (memberUnsafeModifier != null)
                    {
                        this.unsafeDepth++;
                    }

                    try
                    {
                        method = (FunctionDeclarationSyntax)ParseFunctionDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier, memberAsyncModifier);
                    }
                    finally
                    {
                        if (memberUnsafeModifier != null)
                        {
                            this.unsafeDepth--;
                        }
                    }

                    method.WithAnnotations(memberAnnotations);
                    if (memberUnsafeModifier != null)
                    {
                        method.UnsafeModifier = memberUnsafeModifier;
                    }

                    methods.Add(method);
                }
            }
            else
            {
                if (memberOpenModifier != null || memberOverrideModifier != null)
                {
                    var loc = (memberOpenModifier ?? memberOverrideModifier).Location;
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword);
                }

                if (memberAsyncModifier != null)
                {
                    // `async` not followed by `func` — surface as an unexpected token.
                    Diagnostics.ReportUnexpectedToken(memberAsyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
                }

                fields.Add(ParseFieldDeclaration().WithAnnotations(memberAnnotations));
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        var closeBrace = MatchToken(SyntaxKind.CloseBraceToken);
        var structDecl = new StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            structOrClassKeyword,
            primaryCtorOpenParen,
            primaryCtorParameters,
            primaryCtorCloseParen,
            baseColon,
            baseTypeIdentifier,
            additionalBaseIdentifiers.ToImmutable(),
            openBrace,
            fields.ToImmutable(),
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace);
        structDecl.BaseTypeClauses = baseTypeClauses;
        structDecl.SharedBlock = structDecl_sharedBlock;
        structDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen;
        structDecl.BaseConstructorArguments = baseCtorArguments;
        structDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen;
        structDecl.Constructors = constructors.ToImmutable();
        structDecl.Deinitializer = structDecl_deinit;
        structDecl.NestedTypes = nestedTypes.ToImmutable();
        return structDecl;
    }
}
