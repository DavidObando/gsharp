// <copyright file="Parser.Declarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices
import GSharp.Core.CodeAnalysis.Text
import System.Text

open partial class Parser {
    /// ADR-0078 / issue #718: detects whether the current parser position
    /// begins a Kotlin/Swift-style aggregate declaration head — optionally
    /// preceded by modifiers (open, sealed, data, inline, ref) — by scanning
    /// ahead to see if it terminates in one of `class`, `struct`,
    /// `enum`, or `interface`. The scan does not consume tokens.
    /// Returning false leaves dispatch to the legacy `type`-keyword path
    /// (which now only handles type aliases and named delegates).
    private func TryDetectAggregateDeclarationHead() bool {
        return TryDetectAggregateDeclarationHead(0)
    }

    /// Issue #910: offset-aware variant of (cref:TryDetectAggregateDeclarationHead())
    /// used by the class/struct body member loop to recognise a nested type
    /// declaration head that may be preceded by an accessibility modifier
    /// (already peeked at [`startOffset`](paramref)). The scan does not
    /// consume tokens.
    private func TryDetectAggregateDeclarationHead(startOffset int32) bool {
        var offset = startOffset
        let saw = HashSet[string](StringComparer.Ordinal)
        while true {
            let k = Peek(offset)
            if IsProtocolDeclarationHead(offset) {
                return true
            }
            if k.Kind == SyntaxKind.ClassKeyword ||
                k.Kind == SyntaxKind.StructKeyword ||
                k.Kind == SyntaxKind.EnumKeyword ||
                k.Kind == SyntaxKind.InterfaceKeyword {
                return true
            }
            if k.Kind == SyntaxKind.OpenKeyword || k.Kind == SyntaxKind.SealedKeyword {
                offset++
                continue
            }
            // ADR-0122 / issue #1202: `unsafe` composes with the other class
            // modifiers (in any order), establishing an unsafe context for the
            // whole aggregate. Treat it like the other contextual modifiers.
            if k.Kind == SyntaxKind.IdentifierToken &&
                (
                k.Text == "data" ||
                    k.Text == "inline" ||
                    k.Text == "ref" ||
                    k.Text == "unsafe" ||
                    k.Text == "partial" ||
                    k.Text == "abstract" ||
                    k.Text == "shared"
            ) {
                // Bail out if the same contextual modifier appears twice — we are
                // not in a declaration head; let the legacy / statement parser
                // surface the right diagnostic.
                if !saw.Add(k.Text) {
                    return false
                }
                offset++
                continue
            }
            return false
        }
    }

    private func IsProtocolDeclarationHead(offset int32) bool -> Peek(offset).Kind == SyntaxKind.IdentifierToken &&
        Peek(offset).Text == "protocol" && Peek(offset + 1).Kind == SyntaxKind.IdentifierToken &&
        (
        Peek(offset + 2).Kind == SyntaxKind.OpenBraceToken || Peek(
            offset + 2
        ).Kind == SyntaxKind.OpenSquareBracketToken ||
            Peek(offset + 2).Kind == SyntaxKind.ColonToken
    )

    /// ADR-0078 / issue #718: parses an aggregate declaration whose head is
    /// [open|sealed]? [data]? [inline]? [ref]? (class|struct|enum|interface) Name[TParams]? ...
    /// The accessibility modifier was already consumed in (cref:ParseMember).
    /// Issue #1602: depth-guarded — nested type declarations
    /// (`class A { class B { … } }`) recurse through this method.
    private func ParseAggregateDeclaration(accessibilityModifier SyntaxToken?) MemberSyntax {
        EnsureNestedParseAllowed()
        recursionDepth++
        try {
            return ParseAggregateDeclarationCore(accessibilityModifier)
        } finally {
            recursionDepth--
        }
    }

    private func ParseAggregateDeclarationCore(accessibilityModifier SyntaxToken?) MemberSyntax {
        var openModifier SyntaxToken? = nil
        var sealedModifier SyntaxToken? = nil
        var dataKeyword SyntaxToken? = nil
        var inlineKeyword SyntaxToken? = nil
        var refModifier SyntaxToken? = nil
        var unsafeModifier SyntaxToken? = nil
        var partialModifier SyntaxToken? = nil
        var abstractModifier SyntaxToken? = nil
        var sharedModifier SyntaxToken? = nil
        // Collect modifiers in any order. Re-issuing of a modifier is reported
        // as an unexpected token but parsing continues for recovery.
        while true {
            // ADR-0122 / issue #1202: `unsafe` composes with the other class
            // modifiers in any order (e.g. `unsafe open class`, `open unsafe
            // class`). It is a contextual identifier keyword.
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe" {
                if unsafeModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                unsafeModifier = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.OpenKeyword {
                if openModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                openModifier = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.SealedKeyword {
                if sealedModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                sealedModifier = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data" {
                if dataKeyword != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword)
                }
                dataKeyword = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline" {
                if inlineKeyword != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword)
                }
                inlineKeyword = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" {
                if refModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.StructKeyword)
                }
                refModifier = NextToken()
                continue
            }
            // ADR-0195 / issue #4674: `abstract` and `shared` are contextual
            // class modifiers. The head lookahead (TryDetectAggregateDeclarationHead)
            // only reaches this loop when a class/struct/enum/interface keyword
            // follows the run, so an identifier named `abstract` or `shared`
            // elsewhere is unaffected.
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "abstract" {
                if abstractModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                abstractModifier = NextToken()
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" {
                if sharedModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                sharedModifier = NextToken()
                continue
            }
            // ADR-0144 / issue #2201: `partial` is a contextual modifier that
            // composes with the other aggregate modifiers in any order. It is
            // valid on class/struct/interface (rejected on enum below).
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "partial" {
                if partialModifier != nil {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
                }
                partialModifier = NextToken()
                continue
            }
            break
        }
        // Combination rules (ADR-0078):
        //   - data + inline → GS0311
        //   - open + sealed → GS0312
        // The remaining kind-specific rules (open struct, sealed enum, inline
        // class, ...) are validated below once the aggregate keyword is known.
        if dataKeyword != nil && inlineKeyword != nil {
            Diagnostics.ReportDataAndInlineCannotCombine(inlineKeyword.Location)
        }
        if openModifier != nil && sealedModifier != nil {
            Diagnostics.ReportOpenAndSealedCannotCombine(sealedModifier.Location)
        }
        let aggregateKw = Current
        let aggregateKind = aggregateKw.Kind
        let aggregateText = aggregateKw.Text
        if IsProtocolDeclarationHead(0) {
            let protocolKeyword = NextToken()
            let protocolIdentifier = MatchToken(SyntaxKind.IdentifierToken)
            let protocolTypeParameters = ParseOptionalTypeParameterList()
            let declaration = ParseInterfaceDeclarationNew(
                accessibilityModifier,
                sealedModifier,
                protocolKeyword,
                protocolIdentifier,
                protocolTypeParameters
            )
            if openModifier != nil ||
                sealedModifier != nil ||
                dataKeyword != nil ||
                inlineKeyword != nil ||
                refModifier != nil ||
                unsafeModifier != nil ||
                partialModifier != nil ||
                abstractModifier != nil ||
                sharedModifier != nil {
                Diagnostics.ReportNativeProtocol(
                    declaration.Location,
                    "protocol declaration modifiers are not supported"
                )
            }
            return declaration
        }
        if aggregateKind != SyntaxKind.ClassKeyword &&
            aggregateKind != SyntaxKind.StructKeyword &&
            aggregateKind != SyntaxKind.EnumKeyword &&
            aggregateKind != SyntaxKind
            .InterfaceKeyword {
            // Should not happen — TryDetectAggregateDeclarationHead already
            // verified the lookahead. Defensive recovery: emit and bail.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.ClassKeyword)
            NextToken()
            return GlobalStatementSyntax(syntaxTree, ParseStatement())
        }
        // Per-kind modifier validation.
        switch aggregateKind {
            case SyntaxKind.ClassKeyword {
                // ADR-0195 / issue #4674: a `shared` class is emitted CLR `abstract sealed`
                // and holds only `shared` members, so it cannot also be inheritable
                // (`open`, `abstract`), a closed hierarchy (`sealed`) or a record
                // (`data`). Checked only for a `class` head: on `struct`, `enum` and
                // `interface` the modifier itself is the unexpected token.
                if sharedModifier != nil {
                    for conflicting in[]SyntaxToken? {openModifier, sealedModifier, abstractModifier, dataKeyword} {
                        if conflicting != nil {
                            Diagnostics.ReportSharedClassModifierConflict(conflicting.Location, conflicting.Text)
                        }
                    }
                }
                if inlineKeyword != nil {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location)
                }
                if refModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        refModifier.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.StructKeyword
                    )
                }
            }
            case SyntaxKind.StructKeyword {
                ReportAbstractAndSharedOnlyValidOnClass(abstractModifier, sharedModifier, SyntaxKind.StructKeyword)
                if openModifier != nil {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText)
                }
                if sealedModifier != nil {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText)
                }
            }
            case SyntaxKind.EnumKeyword {
                ReportAbstractAndSharedOnlyValidOnClass(abstractModifier, sharedModifier, SyntaxKind.EnumKeyword)
                if openModifier != nil {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText)
                }
                if sealedModifier != nil {
                    Diagnostics.ReportSealedOnlyValidOnClassOrInterface(sealedModifier.Location, aggregateText)
                }
                if dataKeyword != nil {
                    Diagnostics.ReportUnexpectedToken(
                        dataKeyword.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.EnumKeyword
                    )
                }
                if inlineKeyword != nil {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location)
                }
                if refModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        refModifier.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.EnumKeyword
                    )
                }
                if unsafeModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        unsafeModifier.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.EnumKeyword
                    )
                }
                if partialModifier != nil {
                    Diagnostics.ReportPartialNotValidOnKind(partialModifier.Location, "enum")
                }
            }
            case SyntaxKind.InterfaceKeyword {
                ReportAbstractAndSharedOnlyValidOnClass(abstractModifier, sharedModifier, SyntaxKind.InterfaceKeyword)
                if openModifier != nil {
                    Diagnostics.ReportOpenOnlyValidOnClass(openModifier.Location, aggregateText)
                }
                if dataKeyword != nil {
                    Diagnostics.ReportUnexpectedToken(
                        dataKeyword.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.InterfaceKeyword
                    )
                }
                if inlineKeyword != nil {
                    Diagnostics.ReportInlineOnlyValidOnStruct(inlineKeyword.Location)
                }
                if refModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        refModifier.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.InterfaceKeyword
                    )
                }
                if unsafeModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        unsafeModifier.Location,
                        SyntaxKind.IdentifierToken,
                        SyntaxKind.InterfaceKeyword
                    )
                }
            }
            default {
                let _ = 0
            }
        }
        // Consume the aggregate keyword and the identifier, then optional type
        // parameters: `class Name[TParams]?`.
        let aggregateKeyword = NextToken()
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let typeParameterList TypeParameterListSyntax? = ParseOptionalTypeParameterList()
        if aggregateKind == SyntaxKind.EnumKeyword {
            // Note: the unified parser deliberately allows `enum` to fall
            // through to the inner enum production even when stray modifiers
            // were diagnosed above — recovery only.
            if typeParameterList != nil {
                Diagnostics.ReportUnexpectedToken(
                    typeParameterList.OpenBracketToken.Location,
                    SyntaxKind.OpenSquareBracketToken,
                    SyntaxKind.EnumKeyword
                )
            }
            return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier)
        }
        if aggregateKind == SyntaxKind.InterfaceKeyword {
            let interfaceDecl = ParseInterfaceDeclarationNew(
                accessibilityModifier,
                sealedModifier,
                aggregateKeyword,
                identifier,
                typeParameterList
            )
            interfaceDecl.PartialModifier = partialModifier
            return interfaceDecl
        }
        // class / struct path.
        if unsafeModifier != nil {
            this.unsafeDepth++
        }
        let enclosingSharedClassBody = sharedClassBody
        sharedClassBody = sharedModifier != nil && aggregateKind == SyntaxKind.ClassKeyword
        try {
            let structDecl = ParseStructDeclarationNew(
                accessibilityModifier,
                dataKeyword,
                inlineKeyword,
                openModifier,
                sealedModifier,
                refModifier,
                aggregateKeyword,
                identifier
            )
            structDecl.TypeParameterList = typeParameterList
            structDecl.RefModifier = refModifier
            structDecl.AbstractModifier = abstractModifier
            structDecl.SharedModifier = sharedModifier
            structDecl.UnsafeModifier = unsafeModifier
            structDecl.PartialModifier = partialModifier
            return structDecl
        } finally {
            sharedClassBody = enclosingSharedClassBody
            if unsafeModifier != nil {
                this.unsafeDepth--
            }
        }
    }

    /// ADR-0195 / issue #4674: `abstract` and `shared` describe a class
    /// (an uninstantiable or all-shared reference type), so a
    /// `struct`, `enum` or `interface` head that carries either is
    /// an unexpected token, recovered like the other misplaced modifiers.
    private func ReportAbstractAndSharedOnlyValidOnClass(
        abstractModifier SyntaxToken?,
        sharedModifier SyntaxToken?,
        aggregateKind SyntaxKind
    ) {
        if abstractModifier != nil {
            Diagnostics.ReportUnexpectedToken(abstractModifier.Location, SyntaxKind.IdentifierToken, aggregateKind)
        }
        if sharedModifier != nil {
            Diagnostics.ReportUnexpectedToken(sharedModifier.Location, SyntaxKind.IdentifierToken, aggregateKind)
        }
    }

    /// ADR-0078: parses the body of a class or struct declaration whose
    /// modifiers, aggregate keyword, and identifier have already been consumed
    /// by (cref:ParseAggregateDeclaration). Delegates into the shared
    /// body parser by passing the aggregate keyword as preconsumed.
    private func ParseStructDeclarationNew(
        accessibilityModifier SyntaxToken?,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        sealedModifier SyntaxToken?,
        refModifier SyntaxToken?,
        aggregateKeyword SyntaxToken,
        identifier SyntaxToken
    ) StructDeclarationSyntax {
        let decl = ParseStructDeclaration(
            accessibilityModifier,
            typeKeyword: nil,
            identifier,
            dataKeyword,
            inlineKeyword,
            openModifier,
            preconsumedStructOrClassKeyword: aggregateKeyword
        )
        decl.SealedKeyword = sealedModifier
        return decl
    }

    private func ParseEnumDeclarationNew(
        accessibilityModifier SyntaxToken?,
        sealedModifier SyntaxToken?,
        enumKeyword SyntaxToken,
        identifier SyntaxToken
    ) MemberSyntax {
        // The aggregate `enum` keyword is already consumed. Read the body
        // directly, since ParseEnumDeclaration assumes it still has to match
        // the keyword.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "conforms" {
            Diagnostics.ReportNativeProtocol(
                Current.Location,
                "enum protocol conformance is not supported in this core"
            )
            NextToken()
            ParseTypeClause()
            while Current.Kind == SyntaxKind.CommaToken {
                NextToken()
                ParseTypeClause()
            }
        }
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let members = ParseEnumMembers()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        if members.Count == 0 {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text)
        }
        // ADR-0078 / issue #725: if ANY enum member carries a payload, the
        // entire enum is a discriminated union. Desugar it at parse time into
        //   sealed class EnumName { }
        //   class Case1(params) : EnumName { ... }   // per case
        // Flat (non-payload) cases turn into an empty class with the same
        // base, so a uniform pattern-match works on every case.
        var hasAnyPayload = false
        for var i = 0; i < members.Count; i++ {
            if members[i].HasPayload {
                hasAnyPayload = true
                break
            }
        }
        if hasAnyPayload {
            return BuildDiscriminatedUnionDesugaring(
                accessibilityModifier,
                sealedModifier,
                enumKeyword,
                identifier,
                openBrace,
                members,
                closeBrace
            )
        }
        let decl = EnumDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: nil,
            identifier,
            enumKeyword,
            openBrace,
            members,
            closeBrace
        )
        decl.SealedKeyword = sealedModifier
        return decl
    }

    private func BuildDiscriminatedUnionDesugaring(
        accessibilityModifier SyntaxToken?,
        sealedModifier SyntaxToken?,
        enumKeyword SyntaxToken,
        identifier SyntaxToken,
        openBrace SyntaxToken,
        members SeparatedSyntaxList[EnumMemberSyntax],
        closeBrace SyntaxToken
    ) StructDeclarationSyntax {
        // ADR-0078 / issue #725: synthesize `sealed class EnumName {}` as the
        // base, and queue `class CaseName[(params)] : EnumName { }` per case.
        // The Parser.pendingSyntheticMembers queue is drained after the
        // current ParseMember call returns, so the synthetic classes appear
        // immediately after the base in declaration order.
        let classKeyword = SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, enumKeyword.Position, "class", nil)
        let effectiveSealed = sealedModifier ??
            SyntaxToken(syntaxTree, SyntaxKind.SealedKeyword, enumKeyword.Position, "sealed", nil)
        let baseDecl = StructDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: nil,
            identifier,
            dataKeyword: nil,
            inlineKeyword: nil,
            openModifier: nil,
            structKeyword: classKeyword,
            primaryConstructorOpenParen: nil,
            primaryConstructorParameters: SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty),
            primaryConstructorCloseParen: nil,
            baseColonToken: nil,
            baseTypeIdentifier: nil,
            additionalBaseTypeIdentifiers: ImmutableArray[SyntaxToken?].Empty,
            openBraceToken: openBrace,
            fields: ImmutableArray[FieldDeclarationSyntax].Empty,
            properties: ImmutableArray[PropertyDeclarationSyntax].Empty,
            events: ImmutableArray[EventDeclarationSyntax].Empty,
            methods: ImmutableArray[FunctionDeclarationSyntax].Empty,
            closeBraceToken: closeBrace
        )
        baseDecl.SealedKeyword = effectiveSealed
        for var i = 0; i < members.Count; i++ {
            let member = members[i]
            let caseClassKeyword = SyntaxToken(
                syntaxTree,
                SyntaxKind.ClassKeyword,
                member.Identifier.Position,
                "class",
                nil
            )
            let colon = SyntaxToken(syntaxTree, SyntaxKind.ColonToken, member.Identifier.Position, ":", nil)
            let primaryOpen = if member.HasPayload {
                member.PayloadOpenParenthesis
            } else {
                default(SyntaxToken?)
            }
            let primaryClose = if member.HasPayload {
                member.PayloadCloseParenthesis
            } else {
                default(SyntaxToken?)
            }
            let primaryParams = if member.HasPayload {
                member.PayloadParameters
            } else {
                SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty)
            }
            let caseDecl = StructDeclarationSyntax(
                syntaxTree,
                accessibilityModifier: nil,
                typeKeyword: nil,
                member.Identifier,
                dataKeyword: nil,
                inlineKeyword: nil,
                openModifier: nil,
                structKeyword: caseClassKeyword,
                primaryConstructorOpenParen: primaryOpen,
                primaryConstructorParameters: primaryParams,
                primaryConstructorCloseParen: primaryClose,
                baseColonToken: colon,
                baseTypeIdentifier: identifier,
                additionalBaseTypeIdentifiers: ImmutableArray[SyntaxToken?].Empty,
                openBraceToken: openBrace,
                fields: ImmutableArray[FieldDeclarationSyntax].Empty,
                properties: ImmutableArray[PropertyDeclarationSyntax].Empty,
                events: ImmutableArray[EventDeclarationSyntax].Empty,
                methods: ImmutableArray[FunctionDeclarationSyntax].Empty,
                closeBraceToken: closeBrace
            )
            let baseTypeClause = TypeClauseSyntax(syntaxTree, identifier)
            caseDecl.BaseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](
                ImmutableArray.Create[SyntaxNode](baseTypeClause)
            )
            pendingSyntheticMembers.Enqueue(caseDecl)
        }
        return baseDecl
    }

    private func ParseInterfaceDeclarationNew(
        accessibilityModifier SyntaxToken?,
        sealedModifier SyntaxToken?,
        interfaceKeyword SyntaxToken,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?
    ) InterfaceDeclarationSyntax {
        // The aggregate `interface` keyword is already consumed. Build the
        // body by hand (mirroring ParseInterfaceDeclaration but without the
        // up-front MatchToken on the keyword).
        //
        // Issue #1006: an interface may declare one or more base interfaces via
        // a `: A, B` clause directly after the identifier / type-parameter list,
        // mirroring `interface B : A` in C#. Reuse the same comma-separated
        // type-clause parsing the class/struct path uses; the binder enforces
        // that every entry resolves to an interface.
        var baseColon SyntaxToken? = nil
        let baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var baseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](ImmutableArray[SyntaxNode].Empty)
        if Current.Kind == SyntaxKind.ColonToken {
            baseColon = MatchToken(SyntaxKind.ColonToken)
            let firstBaseType = ParseTypeClause()
            baseTypeClauseNodesAndSeparators.Add(firstBaseType)
            while Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                baseTypeClauseNodesAndSeparators.Add(comma)
                let nextType = ParseTypeClause()
                baseTypeClauseNodesAndSeparators.Add(nextType)
            }
            baseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](baseTypeClauseNodesAndSeparators.ToImmutable())
        }
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let properties = ImmutableArray.CreateBuilder[PropertyDeclarationSyntax]()
        let events = ImmutableArray.CreateBuilder[EventDeclarationSyntax]()
        let methods = ImmutableArray.CreateBuilder[FunctionDeclarationSyntax]()
        let staticFields = ImmutableArray.CreateBuilder[FieldDeclarationSyntax]()
        var seenSharedBlock = false
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            // Issue #2129: interface members accept Kotlin-style @annotations
            // (ADR-0047) exactly like class/struct members. Parse the leading
            // annotation list once and attach it to whichever member follows —
            // property, event, or method signature — mirroring how ParseMember
            // threads annotations onto class members.
            let annotations = ParseAnnotations()
            // ADR-0192 / issue #4301 (Copilot review round 4): the sole
            // accessibility modifier an interface method signature accepts —
            // `private` (ADR-0090) — must be consumed BEFORE the partial
            // probe below, or a `partial` between them (`private partial
            // func F();`) strands `private` for the "unexpected token" catch-
            // all further down, doubling up on the intended GS0607.
            let interfaceMemberAccessibility SyntaxToken? = TryConsumeInterfacePrivateBeforePartial()
            // ADR-0192 / issue #4301: partial methods are a `class`/`struct`
            // feature. An interface method signature is already body-less and
            // already expects an implementation elsewhere, so splitting it into
            // a declaring and an implementing part has no meaning — `partial`
            // on an interface member is GS0607. (A `partial interface` TYPE, per
            // ADR-0144, remains legal; only its MEMBERS cannot be partial.)
            if TryConsumePartialFuncModifier(out var interfacePartialModifier) && interfacePartialModifier != nil {
                Diagnostics.ReportPartialModifierNotValidHere(interfacePartialModifier.Location)
            } else {
                TryRejectMisplacedPartialModifier()
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(1).Kind == SyntaxKind
                .OpenBraceToken {
                // Issue #865 revision: static-virtual members live in a
                // `shared { … }` block (ADR-0089), consistent with classes/structs.
                ParseInterfaceSharedBlock(methods, properties, staticFields, &seenSharedBlock, identifier.Text)
            } else if interfaceMemberAccessibility != nil {
                methods.Add(
                    cast[FunctionDeclarationSyntax](
                        ParseInterfaceMethodSignatureCore(
                            interfaceMemberAccessibility,
                            staticModifier: nil
                        ).WithAnnotations(annotations)
                    )
                )
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop" {
                properties.Add(
                    ParsePropertyDeclaration(
                        accessibilityModifier: nil,
                        openModifier: nil,
                        overrideModifier: nil
                    ).WithAnnotations(annotations)
                )
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event" {
                events.Add(
                    ParseEventDeclaration(
                        accessibilityModifier: nil,
                        openModifier: nil,
                        overrideModifier: nil
                    ).WithAnnotations(annotations)
                )
            } else if IsInterfaceMethodSignatureStart() {
                methods.Add(
                    cast[FunctionDeclarationSyntax](ParseInterfaceMethodSignature().WithAnnotations(annotations))
                )
            } else {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword)
                NextToken()
            }
            if Current == startToken {
                NextToken()
            }
        }
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        let interfaceDecl = InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword: nil,
            identifier,
            typeParameterList,
            sealedModifier,
            interfaceKeyword,
            openBrace,
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            closeBrace
        )
        interfaceDecl.BaseColonToken = baseColon
        interfaceDecl.BaseTypeClauses = baseTypeClauses
        interfaceDecl.StaticFields = staticFields.ToImmutable()
        return interfaceDecl
    }

    /// Issue #3510: parses the canonical named delegate declaration
    /// `delegate Name[TParams]?(params) ReturnType? ;`. The required
    /// trailing semicolon terminates the optional return-type clause — the
    /// retired `type Name = delegate func(...)` spelling had no
    /// terminator, so a void delegate greedily consumed whatever declaration
    /// followed it.
    /// @param accessibilityModifier The optional accessibility modifier.
    /// @returns The parsed delegate declaration.
    private func ParseDelegateDeclaration(accessibilityModifier SyntaxToken?) MemberSyntax {
        let delegateKeyword = NextToken()
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let typeParameterList = ParseOptionalTypeParameterList()
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        var returnType TypeClauseSyntax? = nil
        if Current.Kind != SyntaxKind.SemicolonToken && CanStartTypeClause(Current) {
            returnType = ParseTypeClause()
        }
        let semicolon = MatchToken(SyntaxKind.SemicolonToken)
        return DelegateDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            delegateKeyword,
            identifier,
            typeParameterList,
            openParen,
            parameters,
            closeParen,
            returnType,
            semicolon
        )
    }

    private func ParseTypeAliasDeclaration(accessibilityModifier SyntaxToken?) MemberSyntax {
        // Issue #3510: `type` is a contextual identifier now (the dispatcher
        // guarantees an identifier follows at member position).
        let typeKeyword = NextToken()
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        // Phase 4.3 / ADR-0020: optional type-parameter list directly after the
        // type name: `type Box[T any] = ...`. Reuses the same helpers as
        // generic function declarations.
        let typeParameterList = ParseOptionalTypeParameterList()
        // ADR-0078 / issue #718: the only valid uses of the `type` keyword are
        //   `type Name [TParams]? = SomeType`          — erased type alias
        //   `type Name [TParams]? = delegate func(...)` — named CLR delegate
        // Anything else here is a legacy aggregate declaration (`class Name
        // { … }`, `data class Name { … }`, `data struct Name { … }`, …)
        // and must be rejected with GS0306 / GS0307 plus a migration snippet.
        if Current.Kind != SyntaxKind.EqualsToken {
            return ReportAndRecoverLegacyAggregateForm(
                accessibilityModifier,
                typeKeyword,
                identifier,
                typeParameterList
            )
        }
        let equalsToken = MatchToken(SyntaxKind.EqualsToken)
        // Issue #3510: the ADR-0059 `type Name [TParams] = delegate func(...) R`
        // spelling is RETIRED — report the migration diagnostic and recover by
        // parsing the old shape into the same node so downstream binding
        // continues with one clean error.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "delegate" {
            Diagnostics.ReportRetiredDelegateDeclarationForm(typeKeyword.Location, identifier.Text)
            return ParseLegacyDelegateDeclaration(
                accessibilityModifier,
                typeKeyword,
                identifier,
                typeParameterList,
                equalsToken
            )
        }
        let aliasedIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let aliasedType = TypeClauseSyntax(syntaxTree, aliasedIdentifier)
        return TypeAliasDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            equalsToken,
            aliasedType
        )
    }

    /// ADR-0078 / issue #718: emit GS0306 (or GS0307 for `record`) on a
    /// legacy aggregate declaration head (`type Name [mods]? <kind> ...`)
    /// and recover by consuming the modifier/keyword/body sequence as if the
    /// declaration had been written in the new grammar. The recovered syntax
    /// node feeds the rest of the pipeline so that downstream tests see one
    /// high-quality diagnostic instead of a cascade.
    private func ReportAndRecoverLegacyAggregateForm(
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?
    ) MemberSyntax {
        // Collect any legacy modifiers in their original order so the migration
        // suggestion preserves the spelling the user typed.
        let seenSpellings = List[string]()
        var openModifier SyntaxToken? = nil
        var sealedModifier SyntaxToken? = nil
        var dataKeyword SyntaxToken? = nil
        var inlineKeyword SyntaxToken? = nil
        var refModifier SyntaxToken? = nil
        var recordKeyword SyntaxToken? = nil
        var hadRecord = false
        while true {
            if Current.Kind == SyntaxKind.OpenKeyword {
                openModifier = NextToken()
                seenSpellings.Add("open")
                continue
            }
            if Current.Kind == SyntaxKind.SealedKeyword {
                sealedModifier = NextToken()
                seenSpellings.Add("sealed")
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "data" {
                dataKeyword = NextToken()
                seenSpellings.Add("data")
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "inline" {
                inlineKeyword = NextToken()
                seenSpellings.Add("inline")
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" {
                refModifier = NextToken()
                seenSpellings.Add("ref")
                continue
            }
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "record" {
                recordKeyword = NextToken()
                hadRecord = true
                continue
            }
            break
        }
        var aggregateKeyword SyntaxToken? = nil
        var kindText string? = nil
        if hadRecord {
            // `record` becomes `data class` in the new spelling (ref-typed
            // equality-bearing aggregate). We synthesise the class keyword so
            // recovery can run the class-body parser.
            kindText = "data class"
            // hadRecord is set by the same step that assigns recordKeyword and
            // typeKeyword, so both are present throughout this branch.
            aggregateKeyword = SyntaxToken(syntaxTree, SyntaxKind.ClassKeyword, recordKeyword!!.Position, "class", nil)
            if dataKeyword == nil {
                dataKeyword = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordKeyword!!.Position, "data", nil)
            }
            Diagnostics.ReportRecordKeywordRemoved(typeKeyword!!.Location, identifier.Text)
        } else if Current.Kind == SyntaxKind.ClassKeyword ||
            Current.Kind == SyntaxKind.StructKeyword ||
            Current.Kind == SyntaxKind.EnumKeyword ||
            Current.Kind == SyntaxKind
            .InterfaceKeyword {
            aggregateKeyword = NextToken()
            kindText = aggregateKeyword.Text
            let modifierSpelling = if seenSpellings.Count == 0 {
                string.Empty
            } else {
                string.Join(' ', seenSpellings) + " "
            }
            let typeParamSuffix = if typeParameterList == nil {
                string.Empty
            } else {
                RenderTypeParameterList(typeParameterList)
            }
            let migration = "$modifierSpelling$kindText ${identifier.Text}$typeParamSuffix"
            // Reached only for the removed `type X <kind>` spelling, whose
            // `type` keyword this method consumed into typeKeyword.
            Diagnostics.ReportOldTypeDeclarationFormRemoved(typeKeyword!!.Location, migration)
        } else {
            // No `=` AND no aggregate keyword: probably a malformed alias.
            // Emit a generic unexpected-token diagnostic and stop.
            Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.EqualsToken)
            return TypeAliasDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                typeKeyword,
                identifier,
                SyntaxToken(syntaxTree, SyntaxKind.EqualsToken, Current.Position, "=", nil),
                TypeClauseSyntax(
                    syntaxTree,
                    SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, Current.Position, identifier.Text, nil)
                )
            )
        }
        // Recover by feeding the synthesised modifiers + aggregate keyword
        // into the new-grammar aggregate parser so the rest of the file can
        // still be analysed.
        switch aggregateKeyword.Kind {
            case SyntaxKind.EnumKeyword {
                {
                    if typeParameterList != nil {
                        Diagnostics.ReportUnexpectedToken(
                            typeParameterList.OpenBracketToken.Location,
                            SyntaxKind.OpenSquareBracketToken,
                            SyntaxKind.EnumKeyword
                        )
                    }
                    return ParseEnumDeclarationNew(accessibilityModifier, sealedModifier, aggregateKeyword, identifier)
                }
            }
            case SyntaxKind.InterfaceKeyword {
                return ParseInterfaceDeclarationNew(
                    accessibilityModifier,
                    sealedModifier,
                    aggregateKeyword,
                    identifier,
                    typeParameterList
                )
            }
            default {
                {
                    let structDecl = ParseStructDeclarationNew(
                        accessibilityModifier,
                        dataKeyword,
                        inlineKeyword,
                        openModifier,
                        sealedModifier,
                        refModifier,
                        aggregateKeyword,
                        identifier
                    )
                    structDecl.TypeParameterList = typeParameterList
                    structDecl.RefModifier = refModifier
                    return structDecl
                }
            }
        }
    }

    /// ADR-0078 / issue #718: recover from the removed standalone `record`
    /// keyword at member position. Emits GS0307 and parses the rest of the
    /// declaration as if the user had written `data struct Name ...`.
    private func ReportAndRecoverLegacyRecordHead(accessibilityModifier SyntaxToken?) MemberSyntax {
        let recordToken = NextToken()
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        Diagnostics.ReportRecordKeywordRemoved(recordToken.Location, identifier.Text)
        // Recover by parsing the body as a `data struct Name ...` so downstream
        // analysis can still proceed against the (renamed) declaration.
        let syntheticData = SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, recordToken.Position, "data", nil)
        let syntheticStruct = SyntaxToken(syntaxTree, SyntaxKind.StructKeyword, recordToken.Position, "struct", nil)
        return ParseStructDeclarationNew(
            accessibilityModifier,
            dataKeyword: syntheticData,
            inlineKeyword: nil,
            openModifier: nil,
            sealedModifier: nil,
            refModifier: nil,
            aggregateKeyword: syntheticStruct,
            identifier: identifier
        )
    }

    private func ParseLegacyDelegateDeclaration(
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        equalsToken SyntaxToken
    ) MemberSyntax {
        // `delegate` is a contextual keyword that stays as an IdentifierToken
        // — mirrors the existing data/record/inline/ref contextual-modifier
        // handling in ParseTypeAliasDeclaration. We DO NOT promote it to a
        // dedicated SyntaxKind because that would force adding it to
        // SyntaxFacts.GetKeywordKind, breaking any future use of `delegate`
        // as a plain identifier.
        let delegateKeyword = NextToken()
        if Current.Kind != SyntaxKind.FuncKeyword {
            Diagnostics.ReportDelegateDeclarationRequiresFunc(Current.Location)
        }
        let funcKeyword = MatchToken(SyntaxKind.FuncKeyword)
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        // Return type clause is optional; absence means `void`. Issue #3510:
        // this recovery path deliberately does NOT treat a following `func`
        // keyword as a return-type head — the retired spelling's greediness
        // (a void delegate consuming the next declaration) is exactly why it
        // was retired, and GS0535 already fired above.
        var returnType TypeClauseSyntax? = nil
        if Current.Kind != SyntaxKind.FuncKeyword && CanStartTypeClause(Current) {
            returnType = ParseTypeClause()
        }
        return DelegateDeclarationSyntax(
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
            returnType
        )
    }

    private func ParseEnumDeclaration(
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken
    ) EnumDeclarationSyntax {
        let enumKeyword = MatchToken(SyntaxKind.EnumKeyword)
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let members = ParseEnumMembers()
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        if members.Count == 0 {
            Diagnostics.ReportEmptyEnumDeclaration(identifier.Location, identifier.Text)
        }
        return EnumDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
            identifier,
            enumKeyword,
            openBrace,
            members,
            closeBrace
        )
    }

    private func ParseEnumMembers() SeparatedSyntaxList[EnumMemberSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = Current.Kind != SyntaxKind.CloseBraceToken
        while parseNext && Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            // Issue #188 / ADR-0047 §3: each enum-member entry may be
            // preceded by Kotlin-style `@Foo` annotations (default target
            // `field`, since enum members are emitted as static literal
            // fields on the enum type per ECMA-335 §I.8.5.2).
            let annotations = ParseAnnotations()
            let identifier = MatchToken(SyntaxKind.IdentifierToken)
            let member = EnumMemberSyntax(syntaxTree, identifier).WithAnnotations(annotations)
            // ADR-0078 / issue #725: discriminated-union enum case may carry
            // a payload as a primary-constructor parameter list:
            //   enum Shape { Circle(r float64); Square(s float64) }
            // We accept either `;` or `,` between cases — `;` is the canonical
            // separator when payloads are present.
            if Current.Kind == SyntaxKind.OpenParenthesisToken {
                member.PayloadOpenParenthesis = MatchToken(SyntaxKind.OpenParenthesisToken)
                member.PayloadParameters = ParseParameterList()
                member.PayloadCloseParenthesis = MatchToken(SyntaxKind.CloseParenthesisToken)
            }
            // Issue #1912: an enum member may carry an explicit constant value,
            // e.g. `Banana = 2` or `DefaultError = ServerError`. The binder
            // restricts this to a constant-foldable int32 expression (literals,
            // unary +/-/~, +, -, |, &, ^, <<, >>, and references to already-declared
            // sibling members); anything else is a binder-level diagnostic.
            if Current.Kind == SyntaxKind.EqualsToken {
                member.EqualsToken = MatchToken(SyntaxKind.EqualsToken)
                member.Value = ParseBinaryExpression()
            }
            nodesAndSeparators.Add(member)
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else if Current.Kind == SyntaxKind.SemicolonToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.SemicolonToken))
            } else {
                parseNext = false
            }
        }
        return SeparatedSyntaxList[EnumMemberSyntax](nodesAndSeparators.ToImmutable())
    }

    /// Issue #296: matches a base-type name that may be fully qualified
    /// (e.g. `System.IO.MemoryStream`). The dotted segments are folded
    /// into a single (cref:SyntaxKind.IdentifierToken) whose text is the
    /// dotted name, so the binder resolves it via the imported/alias-aware type
    /// resolution path. A bare identifier (e.g. `MemoryStream`) is returned
    /// unchanged.
    private func MatchQualifiedTypeName() SyntaxToken {
        let first = MatchToken(SyntaxKind.IdentifierToken)
        if Current.Kind != SyntaxKind.DotToken || Peek(1).Kind != SyntaxKind.IdentifierToken {
            return first
        }
        var text = first.Text
        while Current.Kind == SyntaxKind.DotToken && Peek(1).Kind == SyntaxKind.IdentifierToken {
            NextToken()
            let segment = MatchToken(SyntaxKind.IdentifierToken)
            text += "." + segment.Text
        }
        return SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, first.Position, text, nil)
    }

    private func ParseStructDeclaration(
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        dataKeyword SyntaxToken?,
        inlineKeyword SyntaxToken?,
        openModifier SyntaxToken?,
        preconsumedStructOrClassKeyword SyntaxToken? = nil
    ) StructDeclarationSyntax {
        let isSharedClassBody = sharedClassBody
        sharedClassBody = false
        let structOrClassKeyword = preconsumedStructOrClassKeyword ??
            (
            if Current.Kind == SyntaxKind.ClassKeyword {
                MatchToken(SyntaxKind.ClassKeyword)
            } else {
                MatchToken(SyntaxKind.StructKeyword)
            }
        )
        // Modifier validation (inline only on struct, open only on class, data
        // combination rules) is now performed in the caller — either
        // ParseAggregateDeclaration (new grammar, ADR-0078) or
        // ParseTypeAliasDeclaration (legacy grammar, GS0306).
        // Phase 3.B.3 sub-step 2: optional Kotlin-style primary constructor
        // parameter list `(name Type, name Type, ...)` directly after the
        // `class` keyword. Each parameter becomes both a ctor argument and a
        // public field of the same name. Both classes and structs accept a
        // primary constructor parameter list.
        var primaryCtorOpenParen SyntaxToken? = nil
        var primaryCtorCloseParen SyntaxToken? = nil
        var primaryCtorParameters = SeparatedSyntaxList[ParameterSyntax](ImmutableArray[SyntaxNode].Empty)
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            primaryCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
            primaryCtorParameters = ParseParameterList()
            primaryCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        }
        // Phase 3.B.3 sub-step 3: optional base clause `: Base`.
        // Phase 3.B.4 extends this to `: Base, IFoo, IBar` — a comma-separated
        // list. The binder classifies each identifier as either the base class
        // (at most one, must come first) or an implemented interface.
        // ADR-0078: structs may carry an implemented-interface clause too;
        // earlier parser-level restrictions are dropped (binder enforces
        // semantic legality, e.g. structs may not have a base class).
        var baseColon SyntaxToken? = nil
        var baseTypeIdentifier SyntaxToken? = nil
        var baseCtorOpenParen SyntaxToken? = nil
        var baseCtorArguments = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        var baseCtorCloseParen SyntaxToken? = nil
        let additionalBaseIdentifiers = ImmutableArray.CreateBuilder[SyntaxToken?]()
        let baseTypeClauseNodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var baseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](ImmutableArray[SyntaxNode].Empty)
        if Current.Kind == SyntaxKind.ColonToken {
            baseColon = MatchToken(SyntaxKind.ColonToken)
            let firstBaseType = ParseTypeClause()
            baseTypeClauseNodesAndSeparators.Add(firstBaseType)
            // ParseTypeClause always produces an Identifier; DottedName only says
            // whether the name was spelled with qualifier segments.
            baseTypeIdentifier = if firstBaseType.DottedName == nil {
                default(SyntaxToken?)
            } else {
                SyntaxToken(
                    syntaxTree,
                    SyntaxKind.IdentifierToken,
                    firstBaseType.Identifier!!.Position,
                    firstBaseType.DottedName,
                    nil
                )
            }
            // Issue #306: optional base-constructor argument list immediately
            // after the base-class name, e.g. `: Exception(message)`. Only the
            // base class (the first identifier) may carry constructor arguments;
            // interfaces never do. The arguments are bound against the base
            // class's constructors and forwarded by the derived ctor.
            if Current.Kind == SyntaxKind.OpenParenthesisToken {
                baseCtorOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
                baseCtorArguments = ParseArguments()
                baseCtorCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
            }
            while Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                baseTypeClauseNodesAndSeparators.Add(comma)
                let nextType = ParseTypeClause()
                baseTypeClauseNodesAndSeparators.Add(nextType)
                // ParseTypeClause always produces an Identifier; DottedName only says
                // whether the name was spelled with qualifier segments.
                let next = if nextType.DottedName == nil {
                    default(SyntaxToken?)
                } else {
                    SyntaxToken(
                        syntaxTree,
                        SyntaxKind.IdentifierToken,
                        nextType.Identifier!!.Position,
                        nextType.DottedName,
                        nil
                    )
                }
                additionalBaseIdentifiers.Add(next)
            }
            baseTypeClauses = SeparatedSyntaxList[TypeClauseSyntax](baseTypeClauseNodesAndSeparators.ToImmutable())
        }
        var openBrace SyntaxToken
        let fields = ImmutableArray.CreateBuilder[FieldDeclarationSyntax]()
        let properties = ImmutableArray.CreateBuilder[PropertyDeclarationSyntax]()
        let events = ImmutableArray.CreateBuilder[EventDeclarationSyntax]()
        let methods = ImmutableArray.CreateBuilder[FunctionDeclarationSyntax]()
        let constructors = ImmutableArray.CreateBuilder[ConstructorDeclarationSyntax]()
        var structDecl_deinit DeinitDeclarationSyntax? = nil
        var structDecl_sharedBlock SharedBlockSyntax? = nil
        let sharedInitializers = ImmutableArray.CreateBuilder[StaticInitializerBlockSyntax]()
        let nestedTypes = ImmutableArray.CreateBuilder[MemberSyntax]()
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
        let isBodyless = Current.Kind != SyntaxKind.OpenBraceToken
        if isBodyless {
            // Issue #5277: the braces are not written. They sit, zero-width, at the end of the last
            // token of the declaration, so the declaration's span stops there and does not reach
            // the next declaration that starts at (cref:Current).
            let bodylessEnd = if position > 0 {
                tokens[position - 1].Span.End
            } else {
                Current.Position
            }
            openBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.OpenBraceToken, bodylessEnd, "{")
            let syntheticCloseBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.CloseBraceToken, bodylessEnd, "}")
            let bodylessDecl = StructDeclarationSyntax(
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
                syntheticCloseBrace
            )
            bodylessDecl.BaseTypeClauses = baseTypeClauses
            bodylessDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen
            bodylessDecl.BaseConstructorArguments = baseCtorArguments
            bodylessDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen
            return bodylessDecl
        }
        openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            // Issue #186 / ADR-0047 §3: each struct/class body member may be
            // preceded by Kotlin-style `@Foo` annotations. For field members
            // the default target is `field`; for method members the existing
            // method-binder path picks them up via MemberSyntax.Annotations.
            let memberAnnotations = ParseAnnotations()
            // Issue #910 / ADR-0110: nested type declarations (class / struct /
            // interface / enum) inside a class or struct body. The declaration
            // head may be preceded by an optional accessibility modifier. Reuse
            // the shared top-level aggregate parser so nested types accept the
            // full declaration grammar (modifiers, type parameters, base
            // clauses, bodies, and recursive nesting).
            {
                let nestedHeadOffset = if (
                    Current.Kind == SyntaxKind.PublicKeyword ||
                        Current.Kind == SyntaxKind.InternalKeyword ||
                        Current.Kind == SyntaxKind.PrivateKeyword ||
                        Current.Kind == SyntaxKind.ProtectedKeyword
                ) {
                    1
                } else {
                    0
                }
                if TryDetectAggregateDeclarationHead(nestedHeadOffset) {
                    var nestedAccessibility SyntaxToken? = nil
                    if nestedHeadOffset == 1 {
                        nestedAccessibility = NextToken()
                    }
                    let nestedType = ParseAggregateDeclaration(nestedAccessibility)
                    nestedType.WithAnnotations(memberAnnotations)
                    nestedTypes.Add(nestedType)
                    // A nested discriminated-union enum desugars into a sealed
                    // base plus one class per case (queued on
                    // pendingSyntheticMembers). Drain them as siblings of the
                    // nested type so they remain nested within this body.
                    while pendingSyntheticMembers.Count > 0 {
                        nestedTypes.Add(pendingSyntheticMembers.Dequeue())
                    }
                    if Current == startToken {
                        NextToken()
                    }
                    continue
                }
            }
            // Phase 3.B.3 sub-step 2b: method declarations inside the body.
            // Use the existing `func Name(args) Ret { body }` parser; the
            // method has no explicit receiver clause — the receiver is the
            // enclosing class. Struct types reject methods (diagnose+skip).
            var memberAccessibility SyntaxToken? = nil
            if Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind
                .ProtectedKeyword {
                // Accessibility modifier may be followed by an optional
                // `open`/`override` and an optional `async` (only meaningful
                // before `func`), then `func`, `prop`, or `event`.
                var ahead = 1
                while Peek(ahead).Kind == SyntaxKind.OpenKeyword || Peek(ahead).Kind == SyntaxKind.OverrideKeyword ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "abstract") {
                    ahead++
                }
                if IsFunctionColorModifier(Peek(ahead).Kind) && Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword {
                    ahead++
                }
                // ADR-0192: skip a `partial`-bearing modifier run so the member
                // keyword AFTER it decides whether this accessibility token is
                // a member modifier. Covers both `public partial func …` (a
                // real partial method) and `public partial prop …` (rejected
                // with GS0607 — but the rejection path only runs if `public`
                // was consumed first). A run without `partial` is left exactly
                // where it was, so no pre-ADR-0192 decision changes.
                // Copilot review round 9: ANY partial-bearing run consumes the
                // accessibility token, whatever member follows — otherwise
                // `public partial var x int32` left `public` for
                // ParseFieldDeclaration, which then read `partial` as the
                // field name (a cascade, no GS0607). The field path below
                // receives the consumed token so the field keeps it.
                let runStart = ahead
                ahead = SkipPartialBearingModifierRun(ahead)
                let partialRunFollows = ahead != runStart
                if partialRunFollows || Peek(ahead).Kind == SyntaxKind.FuncKeyword ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "prop") ||
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "event") ||
                    (
                    Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "init" && Peek(
                        ahead + 1
                    ).Kind == SyntaxKind.OpenParenthesisToken
                ) ||
                    (
                    Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "convenience" &&
                        (
                        (
                            Peek(ahead + 1).Kind == SyntaxKind.IdentifierToken && Peek(ahead + 1).Text == "init" &&
                                Peek(ahead + 2).Kind == SyntaxKind.OpenParenthesisToken
                        ) ||
                            (
                            Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword && Peek(
                                ahead + 2
                            ).Kind == SyntaxKind.IdentifierToken &&
                                Peek(ahead + 2).Text == "init" && Peek(
                                ahead + 3
                            ).Kind == SyntaxKind.OpenParenthesisToken
                        )
                    )
                ) {
                    memberAccessibility = NextToken()
                }
            }
            // Phase 3.B.3 sub-step 3: parse optional `open` / `override`
            // modifiers (any order) before the method's `func` keyword.
            var memberOpenModifier SyntaxToken? = nil
            var memberOverrideModifier SyntaxToken? = nil
            var memberAbstractModifier SyntaxToken? = nil
            while Current.Kind == SyntaxKind.OpenKeyword ||
                Current.Kind == SyntaxKind.OverrideKeyword ||
                (Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "abstract") {
                if Current.Kind == SyntaxKind.OpenKeyword && memberOpenModifier == nil {
                    memberOpenModifier = NextToken()
                } else if Current.Kind == SyntaxKind.OverrideKeyword && memberOverrideModifier == nil {
                    memberOverrideModifier = NextToken()
                } else if Current.Text == "abstract" && memberAbstractModifier == nil {
                    memberAbstractModifier = NextToken()
                } else {
                    // Duplicate modifier — diagnose by consuming and reporting.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.FuncKeyword)
                    NextToken()
                }
            }
            if memberAbstractModifier != nil &&
                !(Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop") {
                Diagnostics.ReportUnexpectedToken(
                    memberAbstractModifier.Location,
                    memberAbstractModifier.Kind,
                    SyntaxKind.IdentifierToken
                )
            }
            // ADR-0192 / issue #4301: `partial` (ADR-0192), `unsafe` (ADR-0122)
            // and one colour modifier — `async`/`suspend` (ADR-0023 /
            // ADR-0174 D4) — may precede `func` on a class/struct instance
            // method in ANY order. All three are consumed by ONE shared,
            // order-independent loop: probing them in a fixed sequence cannot
            // match an ordering that puts `partial` between the colour modifier
            // and `unsafe`, which left a stray token where `func` was expected.
            // Whether the enclosing type is itself `partial` is checked later,
            // by PartialMethodMerger — the aggregate's own `partial` token is
            // not attached until after its member list has been parsed.
            var memberPartialModifier SyntaxToken? = nil
            var memberAsyncModifier SyntaxToken? = nil
            var memberUnsafeModifier SyntaxToken? = nil
            if !TryConsumeFunctionModifierRun(&memberPartialModifier, &memberUnsafeModifier, &memberAsyncModifier) {
                // The run does not end in `func`. Fall back to the exact
                // pre-ADR-0192 probes so malformed input (`unsafe async var x`)
                // still recovers with the diagnostics it always produced.
                if IsFunctionColorModifier(Current.Kind) && Peek(1).Kind == SyntaxKind.FuncKeyword {
                    memberAsyncModifier = NextToken()
                }
                if Current.Kind == SyntaxKind.IdentifierToken &&
                    Current.Text == "unsafe" &&
                    (Peek(1).Kind == SyntaxKind.FuncKeyword || IsFunctionColorModifier(Peek(1).Kind)) {
                    memberUnsafeModifier = NextToken()
                    if memberAsyncModifier == nil && IsFunctionColorModifier(Current.Kind) && Peek(
                        1
                    ).Kind == SyntaxKind.FuncKeyword {
                        memberAsyncModifier = NextToken()
                    }
                }
            }
            // ADR-0192: a `partial` that heads neither a `func` nor a nested
            // aggregate declaration (`partial prop`, `partial event`,
            // `partial var`, …) is rejected with GS0607 here, so it never
            // reaches ParseFieldDeclaration as a stray type-clause token.
            TryRejectMisplacedPartialModifier()
            // ADR-0065 §2: optional `convenience` contextual keyword may
            // precede `init` (or `func init`) on a class constructor.
            var memberConvenienceModifier SyntaxToken? = nil
            if Current.Kind == SyntaxKind.IdentifierToken &&
                Current.Text == "convenience" &&
                (
                (
                    Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(
                        2
                    ).Kind == SyntaxKind.OpenParenthesisToken
                ) ||
                    (
                    Peek(1).Kind == SyntaxKind.FuncKeyword && Peek(2).Kind == SyntaxKind.IdentifierToken && Peek(
                        2
                    ).Text == "init" &&
                        Peek(3).Kind == SyntaxKind.OpenParenthesisToken
                )
            ) {
                memberConvenienceModifier = NextToken()
            }
            if isSharedClassBody && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(
                1
            ).Kind == SyntaxKind
                .OpenBraceToken {
                // ADR-0195 / ADR-0140: in a `shared class` the body IS the shared
                // member list, so `init { … }` is the static initializer that a
                // shared block would hold (a C# static constructor), not a
                // constructor (`init(…)`), which a shared class cannot declare.
                if memberAccessibility != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAccessibility.Location,
                        memberAccessibility.Kind,
                        SyntaxKind.IdentifierToken
                    )
                }
                // `open init { }` / `override init { }`: the modifiers were consumed with the
                // member's other modifiers and would otherwise be dropped without a word.
                let virtualModifier SyntaxToken? = memberOpenModifier ?? memberOverrideModifier
                if virtualModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        virtualModifier.Location,
                        SyntaxKind.OpenKeyword,
                        SyntaxKind.OpenBraceToken
                    )
                }
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let initKeyword = NextToken()
                let initBody = ParseBlockStatement()
                sharedInitializers.Add(StaticInitializerBlockSyntax(syntaxTree, initKeyword, initBody))
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(1).Kind == SyntaxKind
                .OpenParenthesisToken {
                // ADR-0214 gives data structs the existing authored constructor syntax.
                if memberOpenModifier != nil || memberOverrideModifier != nil {
                    // The enclosing `if` tests these same modifiers for non-null,
                    // so the coalesce always yields one of them.
                    let loc = (memberOpenModifier ?? memberOverrideModifier)!!.Location
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken)
                }
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                if structOrClassKeyword.Kind != SyntaxKind.ClassKeyword &&
                    (structOrClassKeyword.Kind != SyntaxKind.StructKeyword || inlineKeyword != nil) {
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken)
                }
                let constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier)
                constructor.WithAnnotations(memberAnnotations)
                constructors.Add(constructor)
            } else if Current.Kind == SyntaxKind.IdentifierToken &&
                Current.Text == "deinit" &&
                (
                Peek(1).Kind == SyntaxKind.OpenBraceToken || Peek(1).Kind == SyntaxKind.OpenParenthesisToken ||
                    (Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(2).Kind == SyntaxKind.OpenBraceToken)
            ) {
                // ADR-0068 / issue #698: `deinit { … }` destructor declaration.
                // The keyword is a contextual identifier — we recognise it only
                // when it is immediately followed by `{` (well-formed case) or
                // by `(` (a malformed parameter-list shape we still want to
                // diagnose, not silently treat as a field).
                if memberAccessibility != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAccessibility.Location,
                        memberAccessibility.Kind,
                        SyntaxKind.IdentifierToken
                    )
                }
                if memberOpenModifier != nil || memberOverrideModifier != nil {
                    // The enclosing `if` tests these same modifiers for non-null,
                    // so the coalesce always yields one of them.
                    let loc = (memberOpenModifier ?? memberOverrideModifier)!!.Location
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.IdentifierToken)
                }
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.IdentifierToken
                    )
                }
                if memberConvenienceModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberConvenienceModifier.Location,
                        memberConvenienceModifier.Kind,
                        SyntaxKind.IdentifierToken
                    )
                }
                let deinitDecl = ParseDeinitDeclaration()
                deinitDecl.WithAnnotations(memberAnnotations)
                if structOrClassKeyword.Kind != SyntaxKind.ClassKeyword {
                    Diagnostics.ReportDeinitOnNonClass(
                        deinitDecl.DeinitKeyword.Location,
                        identifier.Text ?? string.Empty,
                        structOrClassKeyword.Kind
                    )
                }
                if structDecl_deinit != nil {
                    Diagnostics.ReportDuplicateDeinit(
                        deinitDecl.DeinitKeyword.Location,
                        identifier.Text ?? string.Empty
                    )
                } else {
                    structDecl_deinit = deinitDecl
                }
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop" {
                // ADR-0051: property declaration inside struct/class body.
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let property = ParsePropertyDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier)
                property.AbstractModifier = memberAbstractModifier
                property.WithAnnotations(memberAnnotations)
                properties.Add(property)
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event" {
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let eventDecl = ParseEventDeclaration(memberAccessibility, memberOpenModifier, memberOverrideModifier)
                eventDecl.WithAnnotations(memberAnnotations)
                events.Add(eventDecl)
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(
                1
            ).Kind == SyntaxKind
                .OpenBraceToken {
                // ADR-0053: shared block grouping static member declarations.
                if memberAccessibility != nil || memberOpenModifier != nil || memberOverrideModifier != nil {
                    // The enclosing `if` tests these same modifiers for non-null,
                    // so the coalesce always yields one of them.
                    let loc = (memberAccessibility ?? memberOpenModifier ?? memberOverrideModifier)!!.Location
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.IdentifierToken, SyntaxKind.OpenBraceToken)
                }
                if memberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let sharedBlock = ParseSharedBlock()
                if structDecl_sharedBlock != nil {
                    Diagnostics.ReportDuplicateSharedBlock(sharedBlock.SharedKeyword.Location)
                } else {
                    structDecl_sharedBlock = sharedBlock
                }
            } else if Current.Kind == SyntaxKind.FuncKeyword {
                // Issue #656 / ADR-0065: `func init(...)` is accepted as an
                // alternative spelling of the constructor declaration. The
                // `func` keyword is consumed and the remainder is parsed as
                // a normal `init(...)` constructor.
                if Peek(1).Kind == SyntaxKind.IdentifierToken && Peek(1).Text == "init" && Peek(2).Kind == SyntaxKind
                    .OpenParenthesisToken {
                    NextToken() // consume the `func` keyword
                    // Copilot review round 9: TryConsumeFunctionModifierRun
                    // consumed a `partial` here because the run ends in
                    // `func` — but `func init(...)` is a constructor, and
                    // ADR-0192 makes `partial` on `init` GS0607. Without this
                    // the modifier was silently dropped and the constructor
                    // accepted.
                    if memberPartialModifier != nil {
                        Diagnostics.ReportPartialModifierNotValidHere(memberPartialModifier.Location)
                    }
                    if memberOpenModifier != nil || memberOverrideModifier != nil {
                        // The enclosing `if` tests these same modifiers for non-null,
                        // so the coalesce always yields one of them.
                        let loc = (memberOpenModifier ?? memberOverrideModifier)!!.Location
                        Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.OpenParenthesisToken)
                    }
                    if memberAsyncModifier != nil {
                        Diagnostics.ReportUnexpectedToken(
                            memberAsyncModifier.Location,
                            SyntaxKind.AsyncKeyword,
                            SyntaxKind.FuncKeyword
                        )
                    }
                    if structOrClassKeyword.Kind != SyntaxKind.ClassKeyword &&
                        !(
                        structOrClassKeyword.Kind == SyntaxKind.StructKeyword &&
                            dataKeyword != nil &&
                            inlineKeyword == nil
                    ) {
                        Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken)
                    }
                    let constructor = ParseConstructorDeclaration(memberAccessibility, memberConvenienceModifier)
                    constructor.WithAnnotations(memberAnnotations)
                    constructors.Add(constructor)
                } else {
                    // Issue #938 / ADR-0079: in-body `func` instance methods are
                    // the canonical declaration site for owned `class` AND owned
                    // `struct`/`data struct` types. Both aggregate kinds accept
                    // the member here; the binder records it as an instance
                    // method on the receiver type (by-ref `this` for value types).
                    var method FunctionDeclarationSyntax
                    if memberUnsafeModifier != nil {
                        this.unsafeDepth++
                    }
                    try {
                        method = cast[FunctionDeclarationSyntax](
                            ParseFunctionDeclaration(
                                memberAccessibility,
                                memberOpenModifier,
                                memberOverrideModifier,
                                memberAsyncModifier
                            )
                        )
                    } finally {
                        if memberUnsafeModifier != nil {
                            this.unsafeDepth--
                        }
                    }
                    method.WithAnnotations(memberAnnotations)
                    if memberUnsafeModifier != nil {
                        method.UnsafeModifier = memberUnsafeModifier
                    }
                    // ADR-0192 / issue #4301: mark this declaration as one part
                    // of a partial method. PartialMethodMerger collapses the
                    // declaring and implementing parts into one node before the
                    // body binder runs.
                    method.PartialModifier = memberPartialModifier
                    methods.Add(method)
                }
            } else {
                // ADR-0192: `partial` was consumed for a member that did not
                // turn out to be a `func` (the probe requires `func`, so this
                // is only reachable through error recovery). Diagnose rather
                // than silently dropping the modifier.
                if memberPartialModifier != nil {
                    Diagnostics.ReportPartialModifierNotValidHere(memberPartialModifier.Location)
                }
                if memberOpenModifier != nil || memberOverrideModifier != nil {
                    // The enclosing `if` tests these same modifiers for non-null,
                    // so the coalesce always yields one of them.
                    let loc = (memberOpenModifier ?? memberOverrideModifier)!!.Location
                    Diagnostics.ReportUnexpectedToken(loc, SyntaxKind.OpenKeyword, SyntaxKind.FuncKeyword)
                }
                if memberAsyncModifier != nil {
                    // `async` not followed by `func` — surface as an unexpected token.
                    Diagnostics.ReportUnexpectedToken(
                        memberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                fields.Add(ParseFieldDeclaration(memberAccessibility).WithAnnotations(memberAnnotations))
            }
            if Current == startToken {
                NextToken()
            }
        }
        let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        let structDecl = StructDeclarationSyntax(
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
            closeBrace
        )
        structDecl.BaseTypeClauses = baseTypeClauses
        structDecl.SharedBlock = structDecl_sharedBlock
        structDecl.BaseConstructorOpenParenthesisToken = baseCtorOpenParen
        structDecl.BaseConstructorArguments = baseCtorArguments
        structDecl.BaseConstructorCloseParenthesisToken = baseCtorCloseParen
        structDecl.Constructors = constructors.ToImmutable()
        structDecl.Deinitializer = structDecl_deinit
        structDecl.SharedInitializers = sharedInitializers.ToImmutable()
        structDecl.NestedTypes = nestedTypes.ToImmutable()
        return structDecl
    }

    shared {
        private func RenderTypeParameterList(list TypeParameterListSyntax) string {
            let sb = StringBuilder()
            sb.Append('[')
            var first = true
            for p in list.Parameters {
                if !first {
                    sb.Append(", ")
                }
                sb.Append(p.Identifier.Text)
                if p.Constraint != nil {
                    sb.Append(' ')
                    sb.Append(p.Constraint!!.Text)
                }
                first = false
            }
            sb.Append(']')
            return sb.ToString()
        }

        /// Returns true when [`token`](paramref) can start a TypeClauseSyntax.
        /// Shared by parser lookaheads so every type-clause entry point uses the
        /// same complete head-token set.
        private func CanStartTypeClause(token SyntaxToken) bool {
            switch token.Kind {
                case SyntaxKind.IdentifierToken,
                SyntaxKind.FuncKeyword,
                SyntaxKind.OpenParenthesisToken,
                SyntaxKind.OpenSquareBracketToken,
                SyntaxKind.MapKeyword,
                SyntaxKind.ChanKeyword,
                SyntaxKind.SequenceKeyword,
                SyntaxKind.AsyncKeyword,
                SyntaxKind.StarToken {
                    return true
                }
                default {
                    return false
                }
            }
        }

        /// Issue #490: returns true when [`token`](paramref) can plausibly begin an expression
        /// — used by (cref:ParseReturnStatement) to disambiguate the contextual `ref`
        /// modifier from an identifier expression named `ref`.
        private func CanStartExpression(token SyntaxToken) bool {
            switch token.Kind {
                case SyntaxKind.IdentifierToken,
                SyntaxKind.NumberToken,
                SyntaxKind.StringToken,
                SyntaxKind.ByteStringToken,
                SyntaxKind.Utf8StringToken,
                SyntaxKind.OpenParenthesisToken,
                SyntaxKind.OpenSquareBracketToken,
                SyntaxKind.AmpersandToken,
                SyntaxKind.StarToken,
                SyntaxKind.MinusToken,
                SyntaxKind.PlusToken,
                SyntaxKind.BangToken,
                SyntaxKind.TrueKeyword,
                SyntaxKind.FalseKeyword,
                SyntaxKind.NilKeyword,
                SyntaxKind.FuncKeyword {
                    return true
                }
                default {
                    return false
                }
            }
        }
    }
}
