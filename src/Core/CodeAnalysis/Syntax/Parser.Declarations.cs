// <copyright file="Parser.Declarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Syntax;

/// <summary>
/// The GSharp language parser.
/// </summary>

public partial class Parser
{


    // ADR-0078 / issue #725: when a single source-level declaration desugars
    // into multiple synthesized top-level members (notably discriminated-union
    // enums, which expand into a sealed base + one class per case), the
    // expander stages the additional siblings here. `ParseMembers` drains the
    // queue after each `ParseMember` call so they appear in declaration order.
    private readonly Queue<MemberSyntax> pendingSyntheticMembers = new Queue<MemberSyntax>();

    private int position;

    private PackageSyntax ParsePackage()
    {
        if (Current.Kind == SyntaxKind.PackageKeyword)
        {
            var packageKeyword = MatchToken(SyntaxKind.PackageKeyword);
            var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
            identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.DotToken)
            {
                identifiers.Add(MatchToken(SyntaxKind.DotToken));
                identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            return new PackageSyntax(syntaxTree, packageKeyword, identifiers.ToImmutableArray());
        }

        return null;
    }

    private ImmutableArray<MemberSyntax> ParseImports()
    {
        var importsBuilder = ImmutableArray.CreateBuilder<MemberSyntax>();
        while (Current.Kind == SyntaxKind.ImportKeyword)
        {
            var importKeyword = MatchToken(SyntaxKind.ImportKeyword);

            // Detect the alias form: `import <ident> = <ident>(.<ident>)*`.
            // Lookahead: if the next two tokens are IDENT '=', consume them as alias + equals.
            SyntaxToken aliasIdentifier = null;
            SyntaxToken equalsToken = null;
            if (Current.Kind == SyntaxKind.IdentifierToken && Peek(1).Kind == SyntaxKind.EqualsToken)
            {
                aliasIdentifier = MatchToken(SyntaxKind.IdentifierToken);
                equalsToken = MatchToken(SyntaxKind.EqualsToken);
            }

            var identifiers = ImmutableArray.CreateBuilder<SyntaxToken>();
            identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            while (Current.Kind == SyntaxKind.DotToken)
            {
                identifiers.Add(MatchToken(SyntaxKind.DotToken));
                identifiers.Add(MatchToken(SyntaxKind.IdentifierToken));
            }

            importsBuilder.Add(new ImportSyntax(syntaxTree, importKeyword, aliasIdentifier, equalsToken, identifiers.ToImmutableArray()));
        }

        return importsBuilder.ToImmutable();
    }

    private ImmutableArray<MemberSyntax> ParseMembers()
    {
        var members = ImmutableArray.CreateBuilder<MemberSyntax>();

        // ADR-0066 deferred decision D5 (GS0286): top-level statements within a
        // single .gs file must form a single contiguous block — they may all
        // sit at the top of the file, all at the bottom (the Go-style idiom
        // most G# samples and tests follow), or be the only members — but
        // they must not be interleaved with type / function declarations.
        //
        // Track two booleans rather than the strict C# "TLS must precede any
        // declaration" rule because G#'s established idiom is decls-first /
        // trailing-TLS (~488 sources across samples/ and test fixtures use
        // this layout). The contiguous-block rule still catches the truly
        // confusing case (TLS, decl, TLS) without forcing a coordinated
        // rewrite of the existing corpus.
        var seenTopLevelStatement = false;
        var seenDeclarationAfterTopLevel = false;

        while (Current.Kind != SyntaxKind.EndOfFileToken)
        {
            var startToken = Current;

            var member = ParseMember();

            if (member is GlobalStatementSyntax globalStatement)
            {
                if (seenDeclarationAfterTopLevel)
                {
                    Diagnostics.ReportTopLevelStatementsMustBeContiguous(globalStatement.Statement.Location);
                }

                seenTopLevelStatement = true;
            }
            else if (seenTopLevelStatement)
            {
                seenDeclarationAfterTopLevel = true;
            }

            members.Add(member);

            // ADR-0078 / issue #725: drain any synthetic members produced by
            // the desugaring (e.g. discriminated-union enums expand into a
            // sealed base + one class per case).
            while (pendingSyntheticMembers.Count > 0)
            {
                members.Add(pendingSyntheticMembers.Dequeue());
            }

            if (Current == startToken)
            {
                NextToken();
            }
        }

        return members.ToImmutable();
    }

    private MemberSyntax ParseMember()
    {
        // ADR-0047 / issue #141: Kotlin-style annotation lead-ins precede any
        // other modifier on a declaration. We collect them once and then
        // attach the list to whichever member node ParseMember produces.
        var annotations = ParseAnnotations();

        SyntaxToken accessibilityModifier = null;
        if (Current.Kind == SyntaxKind.PublicKeyword ||
            Current.Kind == SyntaxKind.InternalKeyword ||
            Current.Kind == SyntaxKind.PrivateKeyword ||
            Current.Kind == SyntaxKind.ProtectedKeyword)
        {
            accessibilityModifier = NextToken();
        }

        // ADR-0122 / issue #1014: an optional `unsafe` contextual modifier may
        // precede `func` (with or without an accessibility / async modifier).
        // It introduces an unsafe context in which unmanaged raw pointers
        // (`*T`) and raw-pointer operations are legal. The `unsafe` class/struct
        // modifier (issue #1202) is handled inside ParseAggregateDeclaration so
        // it composes with `open`/`sealed`/etc. in any order.
        SyntaxToken unsafeModifier = null;
        if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe"
            && (Peek(1).Kind == SyntaxKind.FuncKeyword
                || Peek(1).Kind == SyntaxKind.AsyncKeyword))
        {
            unsafeModifier = NextToken();
        }

        // Phase 5.1 / ADR-0023: an optional `async` modifier may precede
        // `func` (with or without an accessibility modifier).
        SyntaxToken asyncModifier = null;
        if (Current.Kind == SyntaxKind.AsyncKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword)
        {
            asyncModifier = NextToken();
        }

        MemberSyntax member;
        if (Current.Kind == SyntaxKind.FuncKeyword)
        {
            if (unsafeModifier != null)
            {
                this.unsafeDepth++;
            }

            try
            {
                member = ParseFunctionDeclaration(accessibilityModifier, openModifier: null, overrideModifier: null, asyncModifier);
            }
            finally
            {
                if (unsafeModifier != null)
                {
                    this.unsafeDepth--;
                }
            }

            if (unsafeModifier != null && member is FunctionDeclarationSyntax unsafeFunc)
            {
                unsafeFunc.UnsafeModifier = unsafeModifier;
            }
        }
        else if (TryDetectAggregateDeclarationHead())
        {
            // ADR-0078 / issue #718: the canonical declaration head is
            //   [visibility]? [unsafe]? [open|sealed]? [data]? [inline]? (class|struct|enum|interface) Name ...
            // The aggregate-kind keyword IS the declaration keyword — no leading
            // `type`. Drop into the new aggregate parser path. A leading
            // `unsafe` modifier (issue #1202) is consumed inside
            // ParseAggregateDeclaration so it composes with the other modifiers.
            member = ParseAggregateDeclaration(accessibilityModifier);
        }
        else if (Current.Kind == SyntaxKind.TypeKeyword)
        {
            member = ParseTypeAliasDeclaration(accessibilityModifier);
        }
        else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record"
            && Peek(1).Kind == SyntaxKind.IdentifierToken)
        {
            // ADR-0078 / issue #718: the standalone `record` keyword has been
            // removed. Detect `record Name ...` at member-position, emit
            // GS0307 with a migration suggestion, and recover by parsing the
            // declaration as if the user had written `data struct Name ...`.
            member = ReportAndRecoverLegacyRecordHead(accessibilityModifier);
        }
        else if (accessibilityModifier != null &&
            (Current.Kind == SyntaxKind.VarKeyword ||
             Current.Kind == SyntaxKind.LetKeyword ||
             Current.Kind == SyntaxKind.ConstKeyword))
        {
            var declaration = ParseVariableDeclaration(accessibilityModifier);

            // Issue #187: annotations on a top-level `var`/`let`/`const`
            // belong to the variable declaration itself (default target
            // `field` per ADR-0047 §2), not to the wrapping GlobalStatement.
            // Forward the parsed annotations onto the declaration and clear
            // the local so the trailing `member.WithAnnotations(annotations)`
            // does not double-attach.
            if (declaration is VariableDeclarationSyntax variableDeclaration)
            {
                variableDeclaration.WithAnnotations(annotations);
                annotations = ImmutableArray<AnnotationSyntax>.Empty;
            }

            member = new GlobalStatementSyntax(syntaxTree, declaration);
        }
        else
        {
            if (accessibilityModifier != null)
            {
                Diagnostics.ReportAccessibilityModifierNotAllowedHere(accessibilityModifier.Location, accessibilityModifier.Text);
            }

            if (asyncModifier != null)
            {
                // `async` not followed by `func` — surface as an unexpected token.
                Diagnostics.ReportUnexpectedToken(asyncModifier.Location, SyntaxKind.AsyncKeyword, SyntaxKind.FuncKeyword);
            }

            member = ParseGlobalStatement();

            // Issue #187: a top-level `var`/`let`/`const` without an
            // accessibility modifier is parsed through ParseGlobalStatement →
            // ParseStatement, which has no awareness of member-level
            // annotations. Forward them onto the inner variable declaration
            // so the binder picks them up via VariableDeclarationSyntax.
            if (!annotations.IsDefaultOrEmpty &&
                member is GlobalStatementSyntax wrappingGlobal &&
                wrappingGlobal.Statement is VariableDeclarationSyntax forwardingDeclaration)
            {
                forwardingDeclaration.WithAnnotations(annotations);
                annotations = ImmutableArray<AnnotationSyntax>.Empty;
            }
        }

        return member.WithAnnotations(annotations);
    }

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
            if (k.Kind == SyntaxKind.IdentifierToken && (k.Text == "data" || k.Text == "inline" || k.Text == "ref" || k.Text == "unsafe"))
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
    /// </summary>
    private MemberSyntax ParseAggregateDeclaration(SyntaxToken accessibilityModifier)
    {
        SyntaxToken openModifier = null;
        SyntaxToken sealedModifier = null;
        SyntaxToken dataKeyword = null;
        SyntaxToken inlineKeyword = null;
        SyntaxToken refModifier = null;
        SyntaxToken unsafeModifier = null;

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
            return ParseInterfaceDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier, typeParameterList);
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

            if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind.OpenBraceToken)
            {
                // Issue #865 revision: static-virtual members live in a
                // `shared { … }` block (ADR-0089), consistent with classes/structs.
                ParseInterfaceSharedBlock(methods, properties, staticFields, ref seenSharedBlock, identifier.Text);
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop")
            {
                properties.Add(ParsePropertyDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null));
            }
            else if (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event")
            {
                events.Add(ParseEventDeclaration(accessibilityModifier: null, openModifier: null, overrideModifier: null));
            }
            else if (IsInterfaceMethodSignatureStart())
            {
                methods.Add(ParseInterfaceMethodSignature());
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
}
