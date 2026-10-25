// <copyright file="Parser.Members.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Runtime.CompilerServices

open partial class Parser {
    /// ADR-0192 / issue #4301: probes for the contextual `partial` modifier
    /// at member position and consumes it when it heads a `func` member.
    /// `partial` stays an ordinary identifier everywhere else (`var
    /// partial = 1`, `func partial()`) — it is only special when the
    /// modifier run it starts terminates in `func`, exactly as ADR-0144
    /// made it special only when the run terminates in an aggregate keyword.
    /// @param partialModifier Receives the consumed token, or `null`.
    /// @returns `true` when a `partial` modifier was consumed.
    private func TryConsumePartialFuncModifier(out partialModifier SyntaxToken?) bool {
        partialModifier = nil
        if !PartialModifierIntroducesFunc() {
            return false
        }
        partialModifier = NextToken()
        return true
    }

    /// ADR-0192 / issue #4301 (Copilot review round 4): an interface method
    /// signature's only legal accessibility modifier is `private`
    /// (ADR-0090), and it must be consumed before probing for a misplaced
    /// `partial` — otherwise `private partial func F();` left
    /// `private` for (cref:IsInterfaceMethodSignatureStart),
    /// whose lookahead requires `func` immediately after
    /// `private`. That lookahead fails with `partial` in between,
    /// so the loop fell through to an "unexpected token" diagnostic for
    /// `private` BEFORE the partial probe on the same member ever ran,
    /// producing two diagnostics instead of the intended single GS0607.
    /// Mirrors the class/struct member loop's own accessibility lookahead,
    /// which already skips a partial-bearing run via
    /// (cref:SkipPartialBearingModifierRun) for the same reason.
    /// @returns The consumed `private` token, or `null` when none is consumed.
    private func TryConsumeInterfacePrivateBeforePartial() SyntaxToken? {
        if Current.Kind != SyntaxKind.PrivateKeyword {
            return nil
        }
        if Peek(SkipPartialBearingModifierRun(1)).Kind != SyntaxKind.FuncKeyword {
            return nil
        }
        return NextToken()
    }

    /// ADR-0192: returns `true` when the current token is the
    /// contextual `partial` identifier and the modifier run it starts
    /// terminates in `func`. `unsafe` (ADR-0122) and the function
    /// colour modifiers `async`/`suspend` (ADR-0023/ADR-0174) may
    /// appear between `partial` and `func` in either order, so all of
    /// `partial func`, `partial async func`, `partial unsafe async
    /// func` are recognised. The scan does not consume tokens.
    /// @returns `true` when `partial` heads a `func` member.
    private func PartialModifierIntroducesFunc() bool -> Current.Kind == SyntaxKind.IdentifierToken &&
        Current.Text == "partial" &&
        FunctionModifierRunEndsInFunc(1)

    /// ADR-0192: scans the run of `func`-member modifiers starting at
    /// [`startOffset`](paramref) — `partial` (ADR-0192),
    /// `unsafe` (ADR-0122), and the colour modifiers
    /// `async`/`suspend` (ADR-0023 / ADR-0174 D4), each at most once
    /// and in any order — and reports whether the run terminates in `func`.
    /// The existing probes for those modifiers used to hard-code
    /// `Peek(n) == func`, which is why they must route through this helper
    /// now: `partial` may sit between them and the keyword. The scan does not
    /// consume tokens.
    /// @param startOffset The lookahead offset to start scanning at.
    /// @returns `true` when the modifier run ends in `func`.
    private func FunctionModifierRunEndsInFunc(startOffset int32) bool {
        var offset = startOffset
        var sawUnsafe = false
        var sawColor = false
        var sawPartial = false
        while true {
            let token = Peek(offset)
            if !sawUnsafe && token.Kind == SyntaxKind.IdentifierToken && token.Text == "unsafe" {
                sawUnsafe = true
                offset++
                continue
            }
            if !sawPartial && token.Kind == SyntaxKind.IdentifierToken && token.Text == "partial" {
                sawPartial = true
                offset++
                continue
            }
            if !sawColor && IsFunctionColorModifier(token.Kind) {
                sawColor = true
                offset++
                continue
            }
            break
        }
        return Peek(offset).Kind == SyntaxKind.FuncKeyword
    }

    /// ADR-0192 / issue #4301: consumes the complete run of `func`-member
    /// modifiers at the current token — `partial`, `unsafe`, and one
    /// colour modifier (`async`/`suspend`) — <strong>in any
    /// order</strong>, but only when that run terminates in `func`.
    ///
    /// This is the single consumer every call site routes through. The earlier
    /// shape probed for each modifier in a fixed sequence, which could not
    /// match an ordering that placed `partial` BETWEEN the colour modifier
    /// and `unsafe` (`async partial unsafe func`,
    /// `unsafe partial async func`): the fixed probe consumed one modifier,
    /// skipped past the slot the next one actually occupied, and left a stray
    /// token where `func` was expected — cascading into recovery. A single
    /// order-independent loop is the only way to keep the any-order contract
    /// ADR-0192 §A advertises without every call site re-deriving it.
    ///
    /// Consumes nothing and returns `false` when the run does
    /// not end in `func`, so each caller's pre-ADR-0192 error-recovery
    /// path still sees exactly the tokens it used to.
    /// @param partialModifier Receives the `partial` token, if present.
    /// @param unsafeModifier Receives the `unsafe` token, if present.
    /// @param colorModifier Receives the `async`/`suspend` token, if present.
    /// @returns `true` when the modifier run was consumed.
    private func TryConsumeFunctionModifierRun(
        ref partialModifier SyntaxToken?,
        ref unsafeModifier SyntaxToken?,
        ref colorModifier SyntaxToken?
    ) bool {
        if !FunctionModifierRunEndsInFunc(0) {
            return false
        }
        while Current.Kind != SyntaxKind.FuncKeyword {
            if partialModifier == nil && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "partial" {
                partialModifier = NextToken()
                continue
            }
            if unsafeModifier == nil && Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unsafe" {
                unsafeModifier = NextToken()
                continue
            }
            if colorModifier == nil && IsFunctionColorModifier(Current.Kind) {
                colorModifier = NextToken()
                continue
            }
            break
        }
        return true
    }

    /// ADR-0192: advances [`offset`](paramref) past a modifier run that
    /// contains a `partial` token, so an accessibility lookahead can see
    /// the member keyword (`func`, `prop`, `event`, …) that
    /// actually follows it. Without this, `public partial prop P …` left
    /// `public` unconsumed — the lookahead stopped on `partial`,
    /// matched nothing, and the misplaced-modifier rejection path that issues
    /// GS0607 was never reached, so the user got a field-declaration cascade
    /// instead of the one intended diagnostic.
    ///
    /// Deliberately returns [`offset`](paramref) UNCHANGED when the run
    /// contains no `partial`: a run of `unsafe`/colour modifiers
    /// alone must keep resolving exactly as it did before ADR-0192, so this
    /// helper can never alter a pre-existing lookahead decision.
    /// @param offset The lookahead offset to scan from.
    /// @returns The offset past the run, or the original offset when it holds no `partial`.
    private func SkipPartialBearingModifierRun(offset int32) int32 {
        var scan = offset
        var sawPartial = false
        var sawUnsafe = false
        var sawColor = false
        while true {
            let token = Peek(scan)
            if !sawPartial && token.Kind == SyntaxKind.IdentifierToken && token.Text == "partial" {
                sawPartial = true
                scan++
                continue
            }
            if !sawUnsafe && token.Kind == SyntaxKind.IdentifierToken && token.Text == "unsafe" {
                sawUnsafe = true
                scan++
                continue
            }
            if !sawColor && IsFunctionColorModifier(token.Kind) {
                sawColor = true
                scan++
                continue
            }
            break
        }
        return if sawPartial {
            scan
        } else {
            offset
        }
    }

    /// ADR-0192 / issue #4301: consumes a `partial` token that sits at
    /// member position but heads neither a `func` (ADR-0192) nor an
    /// aggregate declaration (ADR-0144) — for example `partial prop`,
    /// `partial event`, or `partial var` — and reports GS0607. Doing
    /// this here keeps the token out of `ParseFieldDeclaration`, which
    /// would otherwise surface a misleading "expected type clause" cascade.
    /// @returns `true` when a misplaced `partial` was consumed and diagnosed.
    private func TryRejectMisplacedPartialModifier() bool {
        if Current.Kind != SyntaxKind.IdentifierToken ||
            Current.Text != "partial" ||
            PartialModifierIntroducesFunc() ||
            TryDetectAggregateDeclarationHead() {
            return false
        }
        Diagnostics.ReportPartialModifierNotValidHere(Current.Location)
        NextToken()
        return true
    }

    /// ADR-0068 / issue #698: parses a class-body destructor declaration
    /// `deinit { body }`. The keyword carries no parameters, no return
    /// type, no accessibility modifier. A malformed parameter list (the user
    /// wrote `deinit(...)`) is consumed and diagnosed so the parser can
    /// still locate the body block and recover.
    private func ParseDeinitDeclaration() DeinitDeclarationSyntax {
        let deinitKeyword = NextToken() // consume the contextual "deinit" identifier
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            // `deinit(...)` is invalid — destructors take no parameters. Emit
            // a diagnostic at the paren location and consume up to the matching
            // close paren so we still see the body block.
            Diagnostics.ReportDeinitMayNotDeclareParameters(Current.Location)
            NextToken() // consume '('
            var depth = 1
            while depth > 0 && Current.Kind != SyntaxKind.EndOfFileToken && Current.Kind != SyntaxKind.OpenBraceToken {
                if Current.Kind == SyntaxKind.OpenParenthesisToken {
                    depth++
                } else if Current.Kind == SyntaxKind.CloseParenthesisToken {
                    depth--
                    if depth == 0 {
                        NextToken() // consume ')'
                        break
                    }
                }
                NextToken()
            }
        }
        if Current.Kind != SyntaxKind.OpenBraceToken {
            // `deinit T { ... }` (a stray return type) and similar shapes —
            // emit a diagnostic at whatever token sits before the body and
            // consume tokens until we find `{`.
            Diagnostics.ReportDeinitMayNotDeclareReturnType(Current.Location)
            while Current.Kind != SyntaxKind.OpenBraceToken &&
                Current.Kind != SyntaxKind.CloseBraceToken &&
                Current.Kind != SyntaxKind.EndOfFileToken {
                NextToken()
            }
        }
        let body = ParseBlockStatement()
        return DeinitDeclarationSyntax(syntaxTree, deinitKeyword, body)
    }

    /// Issue #306: parses a standalone user-defined constructor
    /// `init(params) [: base(args)] { body }` inside a class or plain-struct body.
    /// ADR-0065 §2: accepts an optional leading `convenience` contextual
    /// modifier passed in by the caller.
    private func ParseConstructorDeclaration(
        accessibilityModifier SyntaxToken?,
        convenienceModifier SyntaxToken? = nil
    ) ConstructorDeclarationSyntax {
        let initKeyword = NextToken() // consume the contextual "init" identifier
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        var baseColon SyntaxToken? = nil
        var baseKeyword SyntaxToken? = nil
        var baseOpenParen SyntaxToken? = nil
        var baseArguments = SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        var baseCloseParen SyntaxToken? = nil
        if Current.Kind == SyntaxKind.ColonToken {
            baseColon = MatchToken(SyntaxKind.ColonToken)
            baseKeyword = MatchToken(SyntaxKind.IdentifierToken)
            baseOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
            baseArguments = ParseArguments()
            baseCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        }
        let body = ParseBlockStatement()
        return ConstructorDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            convenienceModifier,
            initKeyword,
            openParen,
            parameters,
            closeParen,
            baseColon,
            baseKeyword,
            baseOpenParen,
            baseArguments,
            baseCloseParen,
            body
        )
    }

    private func ParseSharedBlock() SharedBlockSyntax {
        let sharedKeyword = NextToken() // consume the contextual "shared" identifier
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let fields = ImmutableArray.CreateBuilder[FieldDeclarationSyntax]()
        let properties = ImmutableArray.CreateBuilder[PropertyDeclarationSyntax]()
        let events = ImmutableArray.CreateBuilder[EventDeclarationSyntax]()
        let methods = ImmutableArray.CreateBuilder[FunctionDeclarationSyntax]()
        let initBlocks = ImmutableArray.CreateBuilder[StaticInitializerBlockSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            // Issue #797: each shared-block member may be preceded by
            // Kotlin-style `@Foo` annotations (ADR-0047 §3), mirroring the
            // instance-member surface in ParseAggregateDeclaration. The default
            // target follows the member kind (field/method/property/event).
            let memberAnnotations = ParseAnnotations()
            var memberAccessibility SyntaxToken? = nil
            if Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind
                .ProtectedKeyword {
                var ahead = 1
                while Peek(ahead).Kind == SyntaxKind.OpenKeyword || Peek(ahead).Kind == SyntaxKind.OverrideKeyword {
                    ahead++
                }
                if IsFunctionColorModifier(Peek(ahead).Kind) && Peek(ahead + 1).Kind == SyntaxKind.FuncKeyword {
                    ahead++
                }
                // ADR-0192: skip a `partial`-bearing modifier run so the
                // member keyword after it decides whether `public` is a member
                // modifier — `public partial func …` inside `shared { }`, and
                // `public partial prop …`, whose GS0607 rejection path only
                // runs once the accessibility token has been consumed.
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
                    (Peek(ahead).Kind == SyntaxKind.IdentifierToken && Peek(ahead).Text == "event") {
                    memberAccessibility = NextToken()
                }
            }
            // ADR-0192 / issue #4301: `partial` (ADR-0192), `unsafe`
            // (ADR-0122 / issue #1036) and one colour modifier (issue #502) may
            // precede `func` on a STATIC method inside a `shared` block in ANY
            // order — the same one shared, order-independent consumer the
            // instance-method path uses. This is the shape the motivating
            // scenario needs: C#'s
            // `[GeneratedRegex] private static partial Regex Foo();` translates
            // to a `partial func` inside `shared { }`. Consuming `unsafe` here
            // also makes the method's SIGNATURE bind in an unsafe context (the
            // binder consults the per-method `IsUnsafe` flag).
            var sharedMemberPartialModifier SyntaxToken? = nil
            var sharedMemberAsyncModifier SyntaxToken? = nil
            var sharedMemberUnsafeModifier SyntaxToken? = nil
            if !TryConsumeFunctionModifierRun(
                &sharedMemberPartialModifier,
                &sharedMemberUnsafeModifier,
                &sharedMemberAsyncModifier
            ) {
                // Pre-ADR-0192 recovery probes, unchanged, for a run that does
                // not end in `func`.
                if IsFunctionColorModifier(Current.Kind) && Peek(1).Kind == SyntaxKind.FuncKeyword {
                    sharedMemberAsyncModifier = NextToken()
                }
                if Current.Kind == SyntaxKind.IdentifierToken &&
                    Current.Text == "unsafe" &&
                    (Peek(1).Kind == SyntaxKind.FuncKeyword || IsFunctionColorModifier(Peek(1).Kind)) {
                    sharedMemberUnsafeModifier = NextToken()
                    if sharedMemberAsyncModifier == nil && IsFunctionColorModifier(Current.Kind) && Peek(
                        1
                    ).Kind == SyntaxKind.FuncKeyword {
                        sharedMemberAsyncModifier = NextToken()
                    }
                }
            }
            // ADR-0192: `partial` on a shared-block member that is not a `func`
            // (`partial prop`, `partial var`, `partial init { }`) is GS0607.
            TryRejectMisplacedPartialModifier()
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(1).Kind == SyntaxKind
                .OpenBraceToken {
                // ADR-0140 / issue #2131: an `init { … }` static-initializer
                // block inside a `shared` block. `init` is contextual — it is
                // only special as the first token of a shared-block member,
                // immediately followed by `{`. Its statements emit into the
                // type's `.cctor` after the static-field initializers.
                if sharedMemberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        sharedMemberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                if memberAccessibility != nil {
                    Diagnostics.ReportUnexpectedToken(
                        memberAccessibility.Location,
                        memberAccessibility.Kind,
                        SyntaxKind.IdentifierToken
                    )
                }
                let initKeyword = NextToken()
                let initBody = ParseBlockStatement()
                initBlocks.Add(StaticInitializerBlockSyntax(syntaxTree, initKeyword, initBody))
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop" {
                if sharedMemberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        sharedMemberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let property = ParsePropertyDeclaration(memberAccessibility, nil, nil)
                property.WithAnnotations(memberAnnotations)
                properties.Add(property)
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "event" {
                if sharedMemberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        sharedMemberAsyncModifier.Location,
                        SyntaxKind.AsyncKeyword,
                        SyntaxKind.FuncKeyword
                    )
                }
                let eventDecl = ParseEventDeclaration(memberAccessibility, nil, nil)
                eventDecl.WithAnnotations(memberAnnotations)
                events.Add(eventDecl)
            } else if Current.Kind == SyntaxKind.FuncKeyword {
                var method FunctionDeclarationSyntax
                if sharedMemberUnsafeModifier != nil {
                    this.unsafeDepth++
                }
                try {
                    method = cast[FunctionDeclarationSyntax](
                        ParseFunctionDeclaration(
                            memberAccessibility,
                            openModifier: nil,
                            overrideModifier: nil,
                            sharedMemberAsyncModifier
                        )
                    )
                } finally {
                    if sharedMemberUnsafeModifier != nil {
                        this.unsafeDepth--
                    }
                }
                method.WithAnnotations(memberAnnotations)
                if sharedMemberUnsafeModifier != nil {
                    method.UnsafeModifier = sharedMemberUnsafeModifier
                }
                // ADR-0192 / issue #4301: mark this static method as one part of
                // a partial method.
                method.PartialModifier = sharedMemberPartialModifier
                methods.Add(method)
            } else {
                // ADR-0192: `partial` consumed for a shared-block member that
                // did not turn out to be a `func` (error recovery only).
                if sharedMemberPartialModifier != nil {
                    Diagnostics.ReportPartialModifierNotValidHere(sharedMemberPartialModifier.Location)
                }
                if sharedMemberAsyncModifier != nil {
                    Diagnostics.ReportUnexpectedToken(
                        sharedMemberAsyncModifier.Location,
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
        return SharedBlockSyntax(
            syntaxTree,
            sharedKeyword,
            openBrace,
            fields.ToImmutable(),
            properties.ToImmutable(),
            events.ToImmutable(),
            methods.ToImmutable(),
            initBlocks.ToImmutable(),
            closeBrace
        )
    }

    private func ParseInterfaceDeclaration(
        accessibilityModifier SyntaxToken?,
        typeKeyword SyntaxToken?,
        identifier SyntaxToken,
        typeParameterList TypeParameterListSyntax?,
        sealedModifier SyntaxToken?
    ) InterfaceDeclarationSyntax {
        let interfaceKeyword = MatchToken(SyntaxKind.InterfaceKeyword)
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        let properties = ImmutableArray.CreateBuilder[PropertyDeclarationSyntax]()
        let events = ImmutableArray.CreateBuilder[EventDeclarationSyntax]()
        let methods = ImmutableArray.CreateBuilder[FunctionDeclarationSyntax]()
        let staticFields = ImmutableArray.CreateBuilder[FieldDeclarationSyntax]()
        var seenSharedBlock = false
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            // Per ADR-0018, interface members are method signatures only.
            // ADR-0051 extends this to also allow property declarations.
            // ADR-0052 extends this to also allow event declarations.
            // Issue #865 revision: static-virtual members (ADR-0089) live in a
            // `shared { … }` block. No accessibility / open / override
            // modifiers are accepted on plain method signatures.
            // Issue #2129: interface members accept Kotlin-style @annotations
            // (ADR-0047) like class members — parse them here and attach to the
            // property / event / method signature that follows.
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
            if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "shared" && Peek(
                1
            ).Kind == SyntaxKind.OpenBraceToken {
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
        let nestedInterfaceDecl = InterfaceDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            typeKeyword,
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
        nestedInterfaceDecl.StaticFields = staticFields.ToImmutable()
        return nestedInterfaceDecl
    }

    /// ADR-0090 / issue #756: returns true if the current token starts an
    /// interface (instance) method signature. The recognised starts are:
    /// - `func`
    /// - `private func` (private instance helper)
    /// Static-virtual members (ADR-0089) and static private helpers (ADR-0090)
    /// are declared inside a `shared { … }` block on the interface
    /// (issue #865 revision); the `static` contextual keyword is no
    /// longer recognised on interface members.
    private func IsInterfaceMethodSignatureStart() bool {
        if Current.Kind == SyntaxKind.FuncKeyword {
            return true
        }
        if Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword {
            return true
        }
        return false
    }

    private func ParseInterfaceMethodSignature() FunctionDeclarationSyntax {
        // ADR-0090 / issue #756: an optional `private` accessibility modifier
        // may precede the `func` token, marking the method a private instance
        // helper. The binder wires private interface members into
        // <c>InterfaceSymbol.PrivateMethods</c> and emits
        // <c>MethodAttributes.Private | HideBySig</c>.
        //
        // Issue #865 revision: static-virtual interface members (ADR-0089) are
        // now declared inside a `shared { … }` block (see
        // <see cref="ParseInterfaceSharedBlock"/>); the `static` contextual
        // keyword is no longer parsed here.
        var accessibilityModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword {
            accessibilityModifier = NextToken()
        }
        return ParseInterfaceMethodSignatureCore(accessibilityModifier, staticModifier: nil)
    }

    /// Parses the shared body of an interface method signature (the part from
    /// `func` onward), shared by the instance path
    /// ((cref:ParseInterfaceMethodSignature)) and the static-virtual
    /// path inside an interface `shared { … }` block
    /// ((cref:ParseInterfaceSharedBlock)). When
    /// [`staticModifier`](paramref) is non-null the resulting function is
    /// marked as a static-virtual interface member (ADR-0089); the binder reads
    /// (cref:FunctionDeclarationSyntax.HasStaticModifier).
    private func ParseInterfaceMethodSignatureCore(
        accessibilityModifier SyntaxToken?,
        staticModifier SyntaxToken?
    ) FunctionDeclarationSyntax {
        let functionKeyword = MatchToken(SyntaxKind.FuncKeyword)
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        // Issue #1007: an interface method may be generic, declaring a
        // type-parameter list `[T]` (and constraints) between the method name
        // and the `(` parameter list, exactly as class methods and free
        // functions do (ADR-0020). Reuse the same helper so the syntax and
        // binding pipeline is identical.
        let typeParameterList = ParseOptionalTypeParameterList()
        let openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken)
        let returnRefModifier = ParseOptionalPropertyReturnRefModifier()
        let returnReadOnlyModifier = ParseOptionalReadOnlyRefModifier(returnRefModifier)
        let type = ParseOptionalTypeClause()
        // ADR-0085 (issue #881 revision): interface methods MAY carry a body
        // (default-interface method). When the body is absent, the method is
        // abstract — but it MUST be terminated with a ';' no-body marker, the
        // universal bodyless-func form (matching P/Invoke, ADR-0086). When a
        // body is present, it is bound through the normal class-method body
        // pipeline and the emitter produces a CLR DIM (virtual, non-abstract);
        // a bodied method takes no ';'. ADR-0089 extends the same
        // body-vs-no-body discriminator to static-virtual (shared) members.
        var body BlockStatementSyntax? = nil
        var semicolonBody SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenBraceToken {
            body = ParseBlockStatement()
        } else if Current.Kind == SyntaxKind.SemicolonToken {
            semicolonBody = NextToken()
        } else {
            Diagnostics.ReportInterfaceMethodMissingSemicolon(identifier.Location, identifier.Text)
        }
        let decl = FunctionDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier: nil,
            overrideModifier: nil,
            functionKeyword,
            receiverOpenParenthesisToken: nil,
            receiver: nil,
            receiverCloseParenthesisToken: nil,
            identifier,
            typeParameterList,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
        decl.StaticModifier = staticModifier
        decl.ReturnRefModifier = returnRefModifier
        decl.ReturnReadOnlyModifier = returnReadOnlyModifier
        decl.SemicolonBodyToken = semicolonBody
        return decl
    }

    /// Issue #865 revision (ADR-0089): parses a `shared { … }` block on an
    /// interface. Each member is a `func` (optionally `private`) and
    /// becomes a static-virtual interface member — abstract when the body is
    /// omitted, default when present (body-vs-no-body discriminator, mirroring
    /// the instance DIM path). The parsed functions are appended to
    /// [`methods`](paramref) with (cref:FunctionDeclarationSyntax.StaticModifier)
    /// set to the `shared` keyword token, so the binder routes them into
    /// `InterfaceSymbol.StaticMethods` /
    /// `InterfaceSymbol.StaticPrivateMethods` via the existing
    /// (cref:FunctionDeclarationSyntax.HasStaticModifier) check.
    /// Non-`func` members are rejected with GS0330 (interface static state
    /// is not supported).
    private func ParseInterfaceSharedBlock(
        methods ImmutableArray[FunctionDeclarationSyntax].Builder,
        properties ImmutableArray[PropertyDeclarationSyntax].Builder,
        fields ImmutableArray[FieldDeclarationSyntax].Builder,
        ref seenSharedBlock bool,
        interfaceName string
    ) {
        let sharedKeyword = NextToken() // consume the contextual "shared" identifier
        if seenSharedBlock {
            Diagnostics.ReportDuplicateSharedBlock(sharedKeyword.Location)
        }
        seenSharedBlock = true
        let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            // ADR-0192 / issue #4301 (Copilot review round 4): skip a
            // partial-bearing run so `private partial func F();` is still
            // recognized as `private`-led — the plain `Peek(1) ==
            // FuncKeyword` check below only matched when nothing sat between
            // `private` and `func`.
            let accessibilityModifier = TryConsumeInterfacePrivateBeforePartial()
            // ADR-0192 / issue #4301: partial methods are out of scope for
            // interfaces (see the instance-member loop above) — that includes
            // an interface's static-virtual `shared { }` slots.
            if TryConsumePartialFuncModifier(out var sharedPartialModifier) && sharedPartialModifier != nil {
                Diagnostics.ReportPartialModifierNotValidHere(sharedPartialModifier.Location)
            } else {
                TryRejectMisplacedPartialModifier()
            }
            if Current.Kind == SyntaxKind.FuncKeyword {
                methods.Add(ParseInterfaceMethodSignatureCore(accessibilityModifier, sharedKeyword))
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop" {
                // ADR-0089 / issue #1019: a `prop` inside an interface shared
                // block is a static-virtual interface property. Mark it with
                // the `shared` keyword as its static modifier so the binder
                // routes it onto InterfaceSymbol static-property accessors.
                let propDecl = ParsePropertyDeclaration(
                    accessibilityModifier: nil,
                    openModifier: nil,
                    overrideModifier: nil
                )
                propDecl.StaticModifier = sharedKeyword
                properties.Add(propDecl)
                // A bare static abstract property (`prop Name T;`) terminates
                // with a semicolon (the universal no-body marker); consume it.
                if Current.Kind == SyntaxKind.SemicolonToken {
                    NextToken()
                }
            } else if Current.Kind == SyntaxKind.VarKeyword ||
                Current.Kind == SyntaxKind.LetKeyword ||
                Current.Kind == SyntaxKind.ConstKeyword ||
                (
                (
                    Current.Kind == SyntaxKind.PublicKeyword ||
                        Current.Kind == SyntaxKind.InternalKeyword ||
                        Current.Kind == SyntaxKind.PrivateKeyword ||
                        Current.Kind == SyntaxKind.ProtectedKeyword
                ) &&
                    (
                    Peek(1).Kind == SyntaxKind.VarKeyword || Peek(1).Kind == SyntaxKind.LetKeyword || Peek(
                        1
                    ).Kind == SyntaxKind.ConstKeyword
                )
            ) {
                // ADR-0089 / issue #1030: interface static *state*. A `var` /
                // `let` / `const` member inside an interface `shared { … }`
                // block declares a CLR static field on the interface TypeDef.
                fields.Add(ParseFieldDeclaration())
            } else {
                // Only `func` (static-virtual) members, `prop` (static-virtual
                // properties, ADR-0089/issue #1019) and `var`/`let`/`const`
                // (interface static state, issue #1030) are allowed inside an
                // interface shared block. Anything else (e.g. `event`) is
                // rejected with GS0330. Report once at the member start, then
                // skip the remainder of the offending declaration so the
                // diagnostic isn't repeated per token.
                Diagnostics.ReportInterfaceSharedMemberMustBeFunc(Current.Location, interfaceName)
                while Current.Kind != SyntaxKind.CloseBraceToken &&
                    Current.Kind != SyntaxKind.EndOfFileToken &&
                    Current.Kind != SyntaxKind.FuncKeyword &&
                    Current.Kind != SyntaxKind.VarKeyword &&
                    Current.Kind != SyntaxKind.LetKeyword &&
                    Current.Kind != SyntaxKind.ConstKeyword &&
                    !(Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "prop") &&
                    !(Current.Kind == SyntaxKind.PrivateKeyword && Peek(1).Kind == SyntaxKind.FuncKeyword) {
                    NextToken()
                }
            }
            if Current == startToken {
                NextToken()
            }
        }
        MatchToken(SyntaxKind.CloseBraceToken)
    }

    private func ParsePropertyDeclaration(
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?
    ) PropertyDeclarationSyntax {
        let propKeyword = MatchToken(SyntaxKind.IdentifierToken) // consumes "prop"
        // ADR-0149: optional explicit-interface qualifier clause
        // `prop (IFoo) P T` / `prop (IFoo) this[...] T`. Properties/indexers
        // have no competing receiver-clause grammar, so any `(` here
        // unambiguously starts this clause.
        var explicitIfaceOpenParen SyntaxToken? = nil
        var explicitIfaceType TypeClauseSyntax? = nil
        var explicitIfaceCloseParen SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen = ParseExplicitInterfaceClause()
        }
        // ADR-0118: indexer member — `prop this[<params>] T { get; set }`.
        // The property name is replaced by the contextual `this` keyword
        // followed by a bracketed index-parameter list.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "this" && Peek(1).Kind == SyntaxKind
            .OpenSquareBracketToken {
            return ParseIndexerDeclaration(
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword
            ).WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen)
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let returnRefModifier SyntaxToken? = ParseOptionalPropertyReturnRefModifier()
        let returnReadOnlyModifier = ParseOptionalReadOnlyRefModifier(returnRefModifier)
        let type = ParseDeclarationTypeClauseBeforeArrowBody(isProperty: true)
        if Current.Kind == SyntaxKind.OpenBraceToken {
            let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            let accessors = ParsePropertyAccessors(isRefReturn: returnRefModifier != nil)
            let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
            return PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace
            )
                .WithReturnRefModifier(returnRefModifier, returnReadOnlyModifier).WithExplicitInterfaceClause(
                explicitIfaceOpenParen,
                explicitIfaceType,
                explicitIfaceCloseParen
            )
        }
        if Current.Kind == SyntaxKind.RightArrowToken {
            // Issue #1278 / ADR-0131: an expression-bodied read-only property
            // `prop Name T -> expr`. Desugar into a single get-only accessor
            // whose body returns the expression (`{ get { return expr } }`).
            // Issue #3879: when the declaration carries `ref`, the synthesized
            // return is a `return ref <lvalue>` — the arrow form is the
            // idiomatic spelling of a ref-returning property, and the getter
            // that comes out of it must not return a copy.
            let (synthOpenBrace, getAccessor, synthCloseBrace) = SynthesizeArrowGetAccessorList(
                asRefReturn: returnRefModifier != nil
            )
            return PropertyDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                propKeyword,
                identifier,
                type,
                synthOpenBrace,
                ImmutableArray.Create(getAccessor),
                synthCloseBrace
            )
                .WithReturnRefModifier(returnRefModifier, returnReadOnlyModifier).WithExplicitInterfaceClause(
                explicitIfaceOpenParen,
                explicitIfaceType,
                explicitIfaceCloseParen
            )
        }
        // Bare auto-property: prop Name Type
        return PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier,
            type,
            openBraceToken: nil,
            accessors: ImmutableArray[PropertyAccessorSyntax].Empty,
            closeBraceToken: nil
        )
            .WithReturnRefModifier(returnRefModifier, returnReadOnlyModifier).WithExplicitInterfaceClause(
            explicitIfaceOpenParen,
            explicitIfaceType,
            explicitIfaceCloseParen
        )
    }

    // Issue #3879 (ADR-0060 amendment): the optional `ref` contextual modifier
    // preceding a property's or indexer's type clause —
    // `prop Value ref int32 { get { return ref this.slot } }`. Recognized with
    // exactly the same lookahead as the `func` return-type form
    // (ParseFunctionDeclaration): `ref` is consumed only when a type clause can
    // start at the next token, so a property literally NAMED `ref`
    // (`prop ref int32`) is unaffected — that name is consumed as the
    // identifier before this runs.
    private func ParseOptionalPropertyReturnRefModifier() SyntaxToken? {
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && CanStartTypeClause(Peek(1)) {
            return NextToken()
        }
        return nil
    }

    private func ParseOptionalReadOnlyRefModifier(refModifier SyntaxToken?) SyntaxToken? -> if refModifier != nil &&
        Current.Kind == SyntaxKind.IdentifierToken &&
        Current.Text == "readonly" &&
        CanStartTypeClause(Peek(1)) {
        NextToken()
    } else {
        default(SyntaxToken?)
    }

    // ADR-0118: parse the indexer member form `prop this[<params>] T { get; set }`.
    // The leading `prop` keyword has already been consumed. The `this` token is
    // current. The resulting PropertyDeclarationSyntax carries IsIndexer = true.
    private func ParseIndexerDeclaration(
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        propKeyword SyntaxToken
    ) PropertyDeclarationSyntax {
        let thisKeyword = MatchToken(SyntaxKind.IdentifierToken) // consumes "this"
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let parameters = ParseIndexerParameterList()
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        let returnRefModifier SyntaxToken? = ParseOptionalPropertyReturnRefModifier()
        let returnReadOnlyModifier = ParseOptionalReadOnlyRefModifier(returnRefModifier)
        let type = ParseDeclarationTypeClauseBeforeArrowBody(isProperty: true)
        var openBrace SyntaxToken? = nil
        var accessors = ImmutableArray[PropertyAccessorSyntax].Empty
        var closeBrace SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenBraceToken {
            openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            accessors = ParsePropertyAccessors(isRefReturn: returnRefModifier != nil)
            closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
        } else if Current.Kind == SyntaxKind.RightArrowToken {
            // Issue #1278 / ADR-0131: an expression-bodied read-only indexer
            // `prop this[i T] U -> expr`, desugared into a get-only accessor.
            // Issue #3879: `prop this[i T] ref U -> expr` desugars to
            // `{ get { return ref expr } }`.
            openBrace,
            let getAccessor,
            closeBrace = SynthesizeArrowGetAccessorList(asRefReturn: returnRefModifier != nil)
            accessors = ImmutableArray.Create(getAccessor)
        }
        return PropertyDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            propKeyword,
            identifier: thisKeyword,
            type,
            openBrace,
            accessors,
            closeBrace
        )
            .WithReturnRefModifier(returnRefModifier, returnReadOnlyModifier).WithIndexer(
            thisKeyword,
            openBracket,
            parameters,
            closeBracket
        )
    }

    // ADR-0118: parse the bracketed index-parameter list of an indexer member.
    // Mirrors ParseParameterList but terminates at the closing square bracket.
    private func ParseIndexerParameterList() SeparatedSyntaxList[ParameterSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNextParameter = true
        while parseNextParameter &&
            Current.Kind != SyntaxKind.CloseSquareBracketToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            let parameter = ParseParameter()
            nodesAndSeparators.Add(parameter)
            if Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                nodesAndSeparators.Add(comma)
            } else {
                parseNextParameter = false
            }
        }
        return SeparatedSyntaxList[ParameterSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseEventDeclaration(
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?
    ) EventDeclarationSyntax {
        let eventKeyword = MatchToken(SyntaxKind.IdentifierToken) // consumes "event"
        // ADR-0149: optional explicit-interface qualifier clause
        // `event (IFoo) Changed T`. Events have no competing receiver-clause
        // grammar, so any `(` here unambiguously starts this clause.
        var explicitIfaceOpenParen SyntaxToken? = nil
        var explicitIfaceType TypeClauseSyntax? = nil
        var explicitIfaceCloseParen SyntaxToken? = nil
        if Current.Kind == SyntaxKind.OpenParenthesisToken {
            explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen = ParseExplicitInterfaceClause()
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        let type = ParseTypeClause()
        if Current.Kind == SyntaxKind.OpenBraceToken {
            let openBrace = MatchToken(SyntaxKind.OpenBraceToken)
            let accessors = ParseEventAccessors()
            let closeBrace = MatchToken(SyntaxKind.CloseBraceToken)
            return EventDeclarationSyntax(
                syntaxTree,
                accessibilityModifier,
                openModifier,
                overrideModifier,
                eventKeyword,
                identifier,
                type,
                openBrace,
                accessors,
                closeBrace
            ).WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen)
        }
        // Field-like event: event Name Type
        return EventDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            eventKeyword,
            identifier,
            type,
            openBraceToken: nil,
            accessors: ImmutableArray[EventAccessorSyntax].Empty,
            closeBraceToken: nil
        ).WithExplicitInterfaceClause(explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen)
    }

    private func ParseEventAccessors() ImmutableArray[EventAccessorSyntax] {
        let accessors = ImmutableArray.CreateBuilder[EventAccessorSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            if Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "add" || Current.Text == "remove" || Current.Text == "raise") {
                let accessorKeyword = NextToken()
                var body BlockStatementSyntax? = nil
                var semicolon SyntaxToken? = nil
                if Current.Kind == SyntaxKind.OpenBraceToken {
                    body = ParseBlockStatement()
                } else if Current.Kind == SyntaxKind.SemicolonToken {
                    semicolon = NextToken()
                }
                accessors.Add(EventAccessorSyntax(syntaxTree, accessorKeyword, body, semicolon))
            } else {
                Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.IdentifierToken)
                NextToken()
            }
            if Current == startToken {
                NextToken()
            }
        }
        return accessors.ToImmutable()
    }

    // Issue #3879: `isRefReturn` propagates the declaration's `ref` modifier
    // into the ADR-0131 arrow accessor form, so `prop P ref int32 { get -> slot }`
    // desugars to `{ get { return ref slot } }` exactly as the whole-member arrow
    // (`prop P ref int32 -> slot`) does. The BLOCK accessor form is untouched:
    // there the user writes `return ref <lvalue>` themselves.
    private func ParsePropertyAccessors(isRefReturn bool = false) ImmutableArray[PropertyAccessorSyntax] {
        let accessors = ImmutableArray.CreateBuilder[PropertyAccessorSyntax]()
        while Current.Kind != SyntaxKind.CloseBraceToken && Current.Kind != SyntaxKind.EndOfFileToken {
            let startToken = Current
            var accessibilityModifier SyntaxToken? = nil
            if (
                Current.Kind == SyntaxKind.PublicKeyword ||
                    Current.Kind == SyntaxKind.InternalKeyword ||
                    Current.Kind == SyntaxKind.PrivateKeyword ||
                    Current.Kind == SyntaxKind.ProtectedKeyword
            ) &&
                Peek(1).Kind == SyntaxKind.IdentifierToken &&
                (Peek(1).Text == "get" || Peek(1).Text == "set" || Peek(1).Text == "init") {
                accessibilityModifier = NextToken()
            }
            if Current.Kind == SyntaxKind.IdentifierToken &&
                (Current.Text == "get" || Current.Text == "set" || Current.Text == "init") {
                let accessorKeyword = NextToken()
                // For set/init, optionally parse (paramName)
                var openParen SyntaxToken? = nil
                var paramIdentifier SyntaxToken? = nil
                var closeParen SyntaxToken? = nil
                if (accessorKeyword.Text == "set" || accessorKeyword.Text == "init") &&
                    Current.Kind == SyntaxKind
                    .OpenParenthesisToken {
                    openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
                    paramIdentifier = MatchToken(SyntaxKind.IdentifierToken)
                    closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
                }
                // Optional body or semicolon
                var body BlockStatementSyntax? = nil
                var semicolon SyntaxToken? = nil
                if Current.Kind == SyntaxKind.OpenBraceToken {
                    body = ParseBlockStatement()
                } else if Current.Kind == SyntaxKind.RightArrowToken {
                    // Issue #1278 / ADR-0131: an expression-bodied accessor
                    // `get -> expr` / `set -> expr` / `init -> expr`. Desugar
                    // into an equivalent block body so binding and emit reuse
                    // the existing accessor-body path: a getter lowers to
                    // `{ return expr }` and a setter/init lowers to `{ expr }`
                    // (an expression statement, typically an assignment using
                    // the `set(name)` value parameter). Note: G# uses the `->`
                    // arrow, never the C# fat arrow `=>`, which remains a
                    // syntax error below.
                    let accessorIsGetter = accessorKeyword.Text == "get"
                    body = ParseArrowExpressionBody(
                        asReturn: accessorIsGetter,
                        asRefReturn: accessorIsGetter && isRefReturn
                    )
                } else if Current.Kind == SyntaxKind.SemicolonToken {
                    semicolon = NextToken()
                } else if !IsAccessorListTerminator() {
                    // Issue #1273: a G# property accessor body is a block `{ }`,
                    // a `->` expression body (issue #1278), or `;` (bare/auto
                    // accessor). Unlike C#, G# has no fat-arrow `=>`
                    // expression-bodied accessor form. Anything else here (e.g.
                    // `get => e`) is a syntax error: report it loudly rather
                    // than silently skipping the tokens, which previously left a
                    // body-less accessor returning the type's default value.
                    Diagnostics.ReportUnexpectedToken(Current.Location, Current.Kind, SyntaxKind.OpenBraceToken)
                    SkipMalformedAccessorBody()
                }
                // else: bare accessor (no body, no semicolon) — valid in interfaces
                accessors.Add(
                    PropertyAccessorSyntax(
                        syntaxTree,
                        accessibilityModifier,
                        accessorKeyword,
                        openParen,
                        paramIdentifier,
                        closeParen,
                        body,
                        semicolon
                    )
                )
            } else {
                // Unknown token in accessor list — skip to avoid infinite loop.
                NextToken()
            }
            if Current == startToken {
                NextToken()
            }
        }
        return accessors.ToImmutable()
    }

    // Issue #1273: a bare (body-less) property accessor is only valid when it is
    // immediately followed by another accessor keyword (`get`/`set`/`init`) or
    // the closing brace of the accessor list. Any other token means the accessor
    // body is malformed (e.g. a `=>`/`->` expression body, which G# does not
    // support).
    private func IsAccessorListTerminator() bool -> Current.Kind == SyntaxKind.CloseBraceToken ||
        Current.Kind == SyntaxKind.EndOfFileToken ||
        (
        Current.Kind == SyntaxKind.IdentifierToken &&
            (Current.Text == "get" || Current.Text == "set" || Current.Text == "init")
    )

    // Issue #1273: recover from a malformed accessor body by skipping tokens
    // until we reach the next accessor keyword, the closing brace, or `;`. This
    // keeps the parser making progress without silently accepting the invalid
    // body.
    private func SkipMalformedAccessorBody() {
        while !IsAccessorListTerminator() && Current.Kind != SyntaxKind.SemicolonToken {
            if Current.Kind == SyntaxKind.OpenBraceToken {
                // A stray block — consume it as a whole so its inner braces do
                // not confuse the accessor-list loop.
                ParseBlockStatement()
                continue
            }
            NextToken()
        }
        if Current.Kind == SyntaxKind.SemicolonToken {
            NextToken()
        }
    }

    private func ParseArrowExpressionBody(asReturn bool, asRefReturn bool = false) BlockStatementSyntax {
        let arrowToken = MatchToken(SyntaxKind.RightArrowToken)
        let arrowPosition = arrowToken.Position
        // Issue #4966 §1 (ADR-0202): `-> { … }` is the same block body an arrow
        // lambda has (ADR-0128) — a statement block with an optional trailing
        // value — not a value-position block expression. It is parsed by the
        // shared block-body parser and desugared to the equivalent block body:
        // `{ stmts; return tail }` for a value-returning member and
        // `{ stmts; tail }` for a void one. With no trailing value the block
        // body is used as written, so `return` statements, a void `for`, or
        // any other statement ending are checked exactly as in
        // `func f() T { … }`. A brace followed by a continuation
        // (`-> { … }.ToString()`, `-> { … } + 1`) is still one expression.
        if Current.Kind == SyntaxKind.OpenBraceToken && !ArrowBraceIsContinued() {
            let block = ParseBlockExpression()
            let bodyStatements = ImmutableArray.CreateBuilder[StatementSyntax]()
            bodyStatements.AddRange(block.Statements)
            let tail = block.Expression
            if tail != nil {
                bodyStatements.Add(SynthesizeArrowBodyStatement(tail, arrowPosition, asReturn, asRefReturn))
            }
            return BlockStatementSyntax(
                syntaxTree,
                block.OpenBraceToken,
                bodyStatements.ToImmutable(),
                block.CloseBraceToken
            )
        }
        let expression = ParseExpression()
        let openBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.OpenBraceToken, arrowPosition, "{")
        let closeBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.CloseBraceToken, expression.Span.End, "}")
        let statement = SynthesizeArrowBodyStatement(expression, arrowPosition, asReturn, asRefReturn)
        return BlockStatementSyntax(syntaxTree, openBrace, ImmutableArray.Create(statement), closeBrace)
    }

    // Issue #4966 (ADR-0202): whether the `{` after `->` is followed, past
    // its matching `}`, by a postfix/binary continuation (`-> { … }.ToString()`),
    // which makes the whole thing one expression. Decided at the real closing
    // brace however long the block is; a capped lookahead would read "not
    // continued" for a long block.
    private func ArrowBraceIsContinued() bool {
        let after = SkipBalancedGroup(0)
        return Peek(after).Kind != SyntaxKind.EndOfFileToken &&
            IsExpressionContinuationAfterBraceAt(after, Peek(after - 1))
    }

    // ADR-0131: the statement an arrow body's value desugars to — `return
    // expr` for a value-returning member and the expression statement `expr`
    // for a void one (a setter/init, or a function without a result type).
    private func SynthesizeArrowBodyStatement(
        expression ExpressionSyntax,
        arrowPosition int32,
        asReturn bool,
        asRefReturn bool
    ) StatementSyntax {
        if !asReturn {
            return ExpressionStatementSyntax(syntaxTree, expression)
        }
        let returnKeyword = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.ReturnKeyword, arrowPosition, "return")
        // Issue #3879: on a `ref`-returning property/indexer the arrow body
        // desugars to `return ref <expr>`, not `return <expr>` — the `ref`
        // is already on the declaration (`prop P ref int32 -> slot`), so
        // repeating it after the arrow would be noise, and desugaring it
        // away would produce a copy-returning getter that GS0252 rejects.
        let refKeyword = if asRefReturn {
            SyntaxToken.Synthesized(syntaxTree, SyntaxKind.IdentifierToken, arrowPosition, "ref")
        } else {
            default(SyntaxToken?)
        }
        return ReturnStatementSyntax(syntaxTree, returnKeyword, refKeyword, expression)
    }

    // Issue #1278 / ADR-0131: synthesize the accessor list for an
    // expression-bodied read-only property or indexer `prop Name T -> expr`.
    // Produces the equivalent of `{ get { return expr } }`: a single get-only
    // accessor whose block body returns the expression, plus synthetic braces
    // for the enclosing accessor list anchored at the arrow's position.
    // Issue #3879: `asRefReturn` produces `{ get { return ref expr } }` for a
    // `ref`-returning property/indexer.
    private func SynthesizeArrowGetAccessorList(asRefReturn bool = false)(
        OpenBrace SyntaxToken,
        GetAccessor PropertyAccessorSyntax,
        CloseBrace SyntaxToken
    ) {
        let arrowPosition = Current.Position
        let body = ParseArrowExpressionBody(asReturn: true, asRefReturn: asRefReturn)
        let getKeyword = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.IdentifierToken, arrowPosition, "get")
        let getAccessor = PropertyAccessorSyntax(
            syntaxTree,
            accessibilityModifier: nil,
            accessorKeyword: getKeyword,
            openParenToken: nil,
            parameterIdentifier: nil,
            closeParenToken: nil,
            body,
            semicolonToken: nil
        )
        let openBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.OpenBraceToken, arrowPosition, "{")
        let closeBrace = SyntaxToken.Synthesized(syntaxTree, SyntaxKind.CloseBraceToken, body.Span.End, "}")
        return (openBrace, getAccessor, closeBrace)
    }

    private func ParseFieldDeclaration(consumedAccessibility SyntaxToken? = nil) FieldDeclarationSyntax {
        // ADR-0192: a member loop that already consumed the accessibility
        // token (to reach a misplaced `partial` after it) passes it in here.
        var fieldAccessibility SyntaxToken? = consumedAccessibility
        if fieldAccessibility == nil &&
            (
            Current.Kind == SyntaxKind.PublicKeyword ||
                Current.Kind == SyntaxKind.InternalKeyword ||
                Current.Kind == SyntaxKind.PrivateKeyword ||
                Current.Kind == SyntaxKind.ProtectedKeyword
        ) {
            fieldAccessibility = NextToken()
        }
        // ADR-0122 §10 / issue #1035: a fixed-size buffer field
        // `fixed name [N]T` inside an (unsafe) struct. `fixed` is a contextual
        // keyword here (it is also the `fixed` pinning statement keyword in a
        // function body — disambiguated by the field position inside a struct
        // body). The element type and count are captured as the `[N]T` array
        // type clause; the field decays to a `*T` to the first element.
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "fixed" && Peek(1).Kind == SyntaxKind
            .IdentifierToken {
            let fixedKeyword = NextToken()
            let fbIdentifier = MatchToken(SyntaxKind.IdentifierToken)
            let fbType = ParseTypeClause()
            return FieldDeclarationSyntax(
                syntaxTree,
                fieldAccessibility,
                varOrLetKeyword: nil,
                fbIdentifier,
                fbType
            ).WithFixedBuffer(fixedKeyword)
        }
        // ADR-0067: field declarations must be introduced with `var` (mutable)
        // or `let` (read-only). Issue #948 adds `const` for compile-time
        // constant fields (implicitly static and read-only). The keyword is
        // captured on the syntax node so the binder can set
        // FieldSymbol.IsReadOnly / IsConst accordingly. If the user omits the
        // keyword, surface a precise diagnostic and try to recover by treating
        // the next identifier as the field name.
        var varOrLetKeyword SyntaxToken? = nil
        if Current.Kind == SyntaxKind.VarKeyword ||
            Current.Kind == SyntaxKind.LetKeyword ||
            Current.Kind == SyntaxKind.ConstKeyword {
            varOrLetKeyword = NextToken()
        } else {
            Diagnostics.ReportFieldDeclarationRequiresVarOrLet(Current.Location)
        }
        let fieldIdentifier = MatchToken(SyntaxKind.IdentifierToken)
        let fieldType = ParseTypeClause()
        // Issue #262: optional initializer for static field declarations.
        var equalsToken SyntaxToken? = nil
        var initializer ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.EqualsToken {
            equalsToken = NextToken()
            initializer = ParseExpression()
        }
        return FieldDeclarationSyntax(
            syntaxTree,
            fieldAccessibility,
            varOrLetKeyword,
            fieldIdentifier,
            fieldType,
            equalsToken,
            initializer
        )
    }

    private func ParseFunctionDeclaration(accessibilityModifier SyntaxToken?) MemberSyntax -> ParseFunctionDeclaration(
        accessibilityModifier,
        openModifier: nil,
        overrideModifier: nil,
        asyncModifier: nil
    )

    private func ParseFunctionDeclaration(
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?
    ) MemberSyntax -> ParseFunctionDeclaration(
        accessibilityModifier,
        openModifier,
        overrideModifier,
        asyncModifier: nil
    )

    private func ParseFunctionDeclaration(
        accessibilityModifier SyntaxToken?,
        openModifier SyntaxToken?,
        overrideModifier SyntaxToken?,
        asyncModifier SyntaxToken?,
        allowExplicitExtension bool = false
    ) MemberSyntax {
        let functionKeyword = MatchToken(SyntaxKind.FuncKeyword)
        // ADR-0182 / issue #4240: `func extension (recv Type) Name(...)` is a
        // retired spelling — every receiver clause is unconditionally an
        // extension now (ADR-0165's marker is redundant), so the keyword is
        // reported as GS0587 and dropped rather than consumed into a
        // semantic modifier. `extension` stays contextual: a normal function
        // named `extension` is unaffected unless a complete receiver-clause
        // shape follows (same lookahead ADR-0165 introduced).
        var retiredExtensionKeyword SyntaxToken? = nil
        if allowExplicitExtension &&
            Current.Kind == SyntaxKind.IdentifierToken &&
            Current.Text == "extension" &&
            LooksLikeExplicitExtensionReceiverClause() {
            retiredExtensionKeyword = NextToken()
            Diagnostics.ReportRetiredExplicitExtensionReceiverModifier(retiredExtensionKeyword.Location)
        }
        var explicitIfaceOpenParen SyntaxToken? = nil
        var explicitIfaceType TypeClauseSyntax? = nil
        var explicitIfaceCloseParen SyntaxToken? = nil
        // ADR-0149: optional explicit-interface qualifier clause `func (IFoo) M(...)`.
        // Checked BEFORE the receiver clause since both start with `(' IdentifierToken;
        // see LooksLikeExplicitInterfaceClause for the disambiguation rule.
        if Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeExplicitInterfaceClause() {
            explicitIfaceOpenParen, explicitIfaceType, explicitIfaceCloseParen = ParseExplicitInterfaceClause()
        }
        var receiverOpenParen SyntaxToken? = nil
        var receiver ParameterSyntax? = nil
        var receiverCloseParen SyntaxToken? = nil
        // Phase 3.B.6 / ADR-0019: optional Go-style receiver clause
        // `func ( recv RecvType ) Name(...)`. We only consume it when the
        // tokens unambiguously look like a receiver: open paren, identifier,
        // a type clause, close paren, followed by an identifier (the name).
        if explicitIfaceType == nil && Current.Kind == SyntaxKind.OpenParenthesisToken && LooksLikeReceiverClause() {
            receiverOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
            receiver = ParseParameter()
            receiverCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        }
        let identifier = MatchOperatorOrIdentifier(
            receiver != nil,
            out var isConversionOperator,
            out var conversionIsExplicit
        )
        let typeParameterList = ParseOptionalTypeParameterList()
        let openParenthesisToken = MatchToken(SyntaxKind.OpenParenthesisToken)
        let parameters = ParseParameterList()
        let closeParenthesisToken = MatchToken(SyntaxKind.CloseParenthesisToken)
        // Issue #490 (ADR-0060 follow-up): optional `ref` contextual modifier preceding
        // the return type clause turns this function into a ref-returning function:
        //   func max(ref a int32, ref b int32) ref int32 { return ref (a > b ? a : b) }
        // The keyword is consumed only when followed by a type-starting token, so a
        // top-level function literally named after the `ref` token is unaffected.
        var returnRefModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "ref" && CanStartTypeClause(Peek(1)) {
            returnRefModifier = NextToken()
        }
        let returnReadOnlyModifier = ParseOptionalReadOnlyRefModifier(returnRefModifier)
        let type TypeClauseSyntax? = ParseOptionalFunctionReturnTypeClause()
        // ADR-0086 / issue #727: a `;` in place of a `{ ... }` body marks the
        // declaration as a P/Invoke stub (`@DllImport`-annotated function with
        // no managed body). The binder validates that the annotation is
        // present and well-formed; an unannotated `;` body produces GS0325.
        var body BlockStatementSyntax?
        var semicolonBody SyntaxToken? = nil
        if Current.Kind == SyntaxKind.SemicolonToken {
            semicolonBody = NextToken()
            body = nil
        } else if Current.Kind == SyntaxKind.RightArrowToken {
            // Issue #1278 / ADR-0131: an expression-bodied function/method
            // `func F(...) T -> expr`. Desugar at parse time into an equivalent
            // block body so binding, lowering, async, and emit reuse the
            // existing block-body path. A non-void function (return type
            // present) lowers to `{ return expr }`; a void function (no return
            // type clause) lowers to `{ expr }` (an expression statement),
            // mirroring C#'s expression-bodied void methods. This single path
            // also covers methods, operators (`func operator + ...`), and
            // user-defined conversion operators (`func operator implicit ...`).
            //
            // ADR-0146 (Kotlin visibility narrowing follow-up): `func F() -> object { ... }`
            // (return-type clause omitted, body is an anonymous-class literal) is the one
            // shape where an omitted return type is still treated as value-returning — the
            // binder infers the return type from the literal, narrowing it at a
            // public/protected boundary per ADR-0146's "Kotlin visibility narrowing" section.
            // Every other omitted-type arrow body keeps the existing void behavior.
            // Issue #3907: an `async` function whose return-type clause spells
            // the VOID-RESULT envelope — `async func F() ValueTask -> Deposit(…)`
            // — is a void function that happens to have a type clause, so its
            // arrow body is an expression STATEMENT like every other void
            // arrow. Issue #1918 lets an async function name its envelope
            // (`Task` / `ValueTask` / `Task[T]` / `ValueTask[T]`) instead of the
            // bare awaited result, and DeclarationBinder unwraps it — but the
            // `type != null` test here runs before any of that and lowered the
            // body to `{ return <void expr> }`, which the binder then rejected
            // with GS0122 + GS0124. Both neighbouring spellings were already
            // right: `func F() -> voidExpr` and `async func F() -> voidExpr`
            // (no clause) both produce a statement. This is the C# shape
            // `public async ValueTask M<T>(…) => VoidCall();`, which is what
            // `AsyncLetCell.Run` is written as.
            body = ParseArrowExpressionBody(
                asReturn: (type != nil && !IsAsyncVoidResultEnvelope(asyncModifier, type)) ||
                    IsAnonymousClassLiteralStartAfterArrow()
            )
        } else {
            body = ParseBlockStatement()
        }
        let decl = FunctionDeclarationSyntax(
            syntaxTree,
            accessibilityModifier,
            openModifier,
            overrideModifier,
            asyncModifier,
            functionKeyword,
            receiverOpenParen,
            receiver,
            receiverCloseParen,
            identifier,
            typeParameterList,
            openParenthesisToken,
            parameters,
            closeParenthesisToken,
            type,
            body
        )
        decl.RetiredExtensionKeyword = retiredExtensionKeyword
        decl.ReturnRefModifier = returnRefModifier
        decl.ReturnReadOnlyModifier = returnReadOnlyModifier
        decl.SemicolonBodyToken = semicolonBody
        decl.IsConversionOperator = isConversionOperator
        decl.ConversionIsExplicit = conversionIsExplicit
        decl.ExplicitInterfaceOpenParenthesisToken = explicitIfaceOpenParen
        decl.ExplicitInterfaceType = explicitIfaceType
        decl.ExplicitInterfaceCloseParenthesisToken = explicitIfaceCloseParen
        return decl
    }

    private func ParseOptionalFunctionReturnTypeClause() TypeClauseSyntax? {
        if !CanStartTypeClause(Current) ||
            (Current.Kind == SyntaxKind.IdentifierToken && IsContextualMemberKeyword(Current.Text)) {
            return nil
        }
        return ParseDeclarationTypeClauseBeforeArrowBody(isProperty: false)
    }

    private func ParseDeclarationTypeClauseBeforeArrowBody(isProperty bool) TypeClauseSyntax {
        if !LooksLikeTupleTypeBeforeArrowBody(isProperty, out var tupleOffset) {
            return ParseTypeClause()
        }
        let previous = tupleTypeBeforeArrowBodyPosition
        tupleTypeBeforeArrowBodyPosition = Peek(tupleOffset).Position
        try {
            return ParseTypeClause()
        } finally {
            tupleTypeBeforeArrowBodyPosition = previous
        }
    }

    private func LooksLikeTupleTypeBeforeArrowBody(isProperty bool, out tupleOffset int32) bool {
        tupleOffset = 0
        var openBracketAlreadyConsumed = false
        while openBracketAlreadyConsumed || Peek(tupleOffset).Kind == SyntaxKind.OpenSquareBracketToken {
            if !openBracketAlreadyConsumed {
                tupleOffset++
            }
            openBracketAlreadyConsumed = false
            if Peek(tupleOffset).Kind == SyntaxKind.NumberToken {
                tupleOffset++
            } else {
                while Peek(tupleOffset).Kind == SyntaxKind.CommaToken {
                    tupleOffset++
                }
            }
            if Peek(tupleOffset).Kind != SyntaxKind.CloseSquareBracketToken {
                return false
            }
            tupleOffset++
            if Peek(tupleOffset).Kind == SyntaxKind.QuestionOpenBracketToken {
                tupleOffset++
                openBracketAlreadyConsumed = true
            } else if Peek(tupleOffset).Kind == SyntaxKind.QuestionToken {
                tupleOffset++
            }
        }
        if !LooksLikeArrowFunctionTypeClauseStart(tupleOffset, out var hasTopLevelComma) || !hasTopLevelComma {
            return false
        }
        var functionTypeEnd = 0
        if !TryScanTypeClause(&functionTypeEnd) {
            return true
        }
        let endKind = Peek(functionTypeEnd).Kind
        if endKind == SyntaxKind.SemicolonToken || endKind == SyntaxKind.RightArrowToken {
            return false
        }
        if isProperty && IsFunctionTypedPropertyFollower(functionTypeEnd) {
            return false
        }
        if endKind != SyntaxKind.OpenBraceToken {
            return true
        }
        if !isProperty {
            return false
        }
        let firstBodyToken = Peek(functionTypeEnd + 1)
        return firstBodyToken.Kind != SyntaxKind.CloseBraceToken &&
            !(firstBodyToken.Kind == SyntaxKind.IdentifierToken && (firstBodyToken.Text is "get" or "set" or "init")) &&
            !(
            (
                (
                    firstBodyToken.Kind is SyntaxKind.PublicKeyword or
                        SyntaxKind.InternalKeyword or
                        SyntaxKind.PrivateKeyword or
                        SyntaxKind.ProtectedKeyword
                )
            ) &&
                Peek(functionTypeEnd + 2).Kind == SyntaxKind.IdentifierToken &&
                (Peek(functionTypeEnd + 2).Text is "get" or "set" or "init")
        )
    }

    private func IsFunctionTypedPropertyFollower(offset int32) bool {
        if TryDetectAggregateDeclarationHead(offset) {
            return true
        }
        if LooksLikeContextualAggregateMemberHead(offset) {
            return true
        }
        let token = Peek(offset)
        if (
            token.Kind is SyntaxKind.EndOfFileToken or
                SyntaxKind.CloseBraceToken or
                SyntaxKind.AtToken or
                SyntaxKind.FuncKeyword or
                SyntaxKind.AsyncKeyword or
                SyntaxKind.VarKeyword or
                SyntaxKind.LetKeyword or
                SyntaxKind.ConstKeyword or
                SyntaxKind.PublicKeyword or
                SyntaxKind.InternalKeyword or
                SyntaxKind.PrivateKeyword or
                SyntaxKind.ProtectedKeyword or
                SyntaxKind.OpenKeyword or
                SyntaxKind.OverrideKeyword
        ) {
            return true
        }
        return false
    }

    private func LooksLikeContextualAggregateMemberHead(offset int32) bool {
        let token = Peek(offset)
        if token.Kind != SyntaxKind.IdentifierToken {
            return false
        }
        if (token.Text is "prop" or "event") {
            return true
        }
        if token.Text == "fixed" {
            return Peek(offset + 1).Kind == SyntaxKind.IdentifierToken
        }
        if token.Text == "init" {
            return Peek(offset + 1).Kind == SyntaxKind.OpenParenthesisToken
        }
        if token.Text == "shared" {
            return Peek(offset + 1).Kind == SyntaxKind.OpenBraceToken
        }
        if token.Text == "unsafe" {
            return Peek(offset + 1).Kind == SyntaxKind.FuncKeyword ||
                (Peek(offset + 1).Kind == SyntaxKind.AsyncKeyword && Peek(offset + 2).Kind == SyntaxKind.FuncKeyword)
        }
        if token.Text == "convenience" {
            return (
                Peek(offset + 1).Kind == SyntaxKind.IdentifierToken && Peek(offset + 1).Text == "init" && Peek(
                    offset + 2
                ).Kind == SyntaxKind.OpenParenthesisToken
            ) ||
                (
                Peek(offset + 1).Kind == SyntaxKind.FuncKeyword && Peek(
                    offset + 2
                ).Kind == SyntaxKind.IdentifierToken &&
                    Peek(offset + 2).Text == "init" && Peek(offset + 3).Kind == SyntaxKind.OpenParenthesisToken
            )
        }
        return token.Text == "deinit" &&
            (
            Peek(offset + 1).Kind == SyntaxKind.OpenBraceToken || Peek(
                offset + 1
            ).Kind == SyntaxKind.OpenParenthesisToken ||
                (
                Peek(offset + 1).Kind == SyntaxKind.IdentifierToken && Peek(
                    offset + 2
                ).Kind == SyntaxKind.OpenBraceToken
            )
        )
    }

    // Stream D: `func (a Point) operator +(b Point) Point { … }`. After the
    // optional receiver clause, if the current token is the contextual
    // `operator` keyword we consume it and the following operator token, then
    // synthesize an IdentifierToken whose text is the CLR op_* name (e.g.
    // `op_Addition`). Downstream binding sees a regular extension function with
    // that name; the binder later hooks `BindBinaryExpression` /
    // `BindUnaryExpression` to look up `op_*` on the user type's symbol.
    private func MatchOperatorOrIdentifier(
        hasReceiver bool,
        out isConversionOperator bool,
        out conversionIsExplicit bool
    ) SyntaxToken {
        isConversionOperator = false
        conversionIsExplicit = false
        if Current.Kind != SyntaxKind.OperatorKeyword {
            return MatchToken(SyntaxKind.IdentifierToken)
        }
        // Issue #1017: user-defined conversion operators are spelled
        // `func operator implicit (x T) U { … }` (or `explicit`). `implicit`
        // and `explicit` are contextual keywords recognised only immediately
        // after `operator`; elsewhere they remain ordinary identifiers. A
        // conversion operator has no receiver clause — the single parameter is
        // the source operand and the return type is the conversion target.
        if !hasReceiver && Current.Kind == SyntaxKind.OperatorKeyword && Peek(1).Kind == SyntaxKind.IdentifierToken &&
            (Peek(1).Text == "implicit" || Peek(1).Text == "explicit") {
            let conversionOperatorKeyword = NextToken()
            let conversionKindToken = NextToken()
            isConversionOperator = true
            conversionIsExplicit = conversionKindToken.Text == "explicit"
            let conversionName = if conversionIsExplicit {
                "op_Explicit"
            } else {
                "op_Implicit"
            }
            return SyntaxToken(
                syntaxTree,
                SyntaxKind.IdentifierToken,
                conversionOperatorKeyword.Position,
                conversionName,
                nil
            )
        }
        let operatorKeyword = NextToken()
        let operatorToken = NextToken()
        // Issue #2834 / ADR-0035: a compound-assignment operator token (`+=`,
        // `-=`, …) is unambiguous — it is never a binary or unary operator —
        // so it is mapped before the binary/unary disambiguation below. The
        // declaration is an instance, void-returning method taking the
        // right-hand operand, and is accepted in BOTH the receiver-clause form
        // (`func (b Bag) operator +=(n int32)`) and the in-body form
        // (`public func operator +=(n int32)` inside the type's body).
        let compoundName string? = OperatorNames.TryGetCompoundAssignmentName(operatorToken.Kind)
        if compoundName != nil {
            return SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, operatorKeyword.Position, compoundName, nil)
        }
        // Disambiguate binary vs unary by peeking the parameter list. With a
        // receiver clause, the parameter list contains only the *extra*
        // operands — empty list ⇒ unary, otherwise binary. (Free-function
        // form without a receiver is not yet wired through this path.)
        let isUnary = hasReceiver && Current.Kind == SyntaxKind.OpenParenthesisToken && Peek(
            1
        ).Kind == SyntaxKind.CloseParenthesisToken
        let name string? = if isUnary {
            OperatorNames.TryGetUnaryName(operatorToken.Kind)
        } else {
            OperatorNames.TryGetBinaryName(operatorToken.Kind) ?? OperatorNames.TryGetUnaryName(operatorToken.Kind)
        }
        if name == nil {
            Diagnostics.ReportUnexpectedToken(operatorToken.Location, operatorToken.Kind, SyntaxKind.PlusToken)
            return SyntaxToken(
                syntaxTree,
                SyntaxKind.IdentifierToken,
                operatorKeyword.Position,
                "__bad_operator__",
                nil
            )
        }
        return SyntaxToken(syntaxTree, SyntaxKind.IdentifierToken, operatorKeyword.Position, name, nil)
    }

    private func ParseOptionalTypeParameterList() TypeParameterListSyntax? {
        // Phase 4.1 / ADR-0020: a generic type-parameter list `[T any, U any]`
        // appears immediately after the declared name of func/class/struct/
        // data struct/interface. The token following the name is unambiguously
        // either `[` (TPs) or `(` / `{` / type clause (no TPs).
        if Current.Kind != SyntaxKind.OpenSquareBracketToken || !LooksLikeTypeParameterList() {
            return nil
        }
        let openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNext = true
        while parseNext &&
            Current.Kind != SyntaxKind.CloseSquareBracketToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            nodesAndSeparators.Add(ParseTypeParameter())
            if Current.Kind == SyntaxKind.CommaToken {
                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
            } else {
                parseNext = false
            }
        }
        let closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
        return TypeParameterListSyntax(
            syntaxTree,
            openBracket,
            SeparatedSyntaxList[TypeParameterSyntax](nodesAndSeparators.ToImmutable()),
            closeBracket
        )
    }

    private func LooksLikeTypeParameterList() bool {
        // We are positioned at `[`. A type parameter list looks like
        // `[ Ident (Ident|class|struct|init())? ( , ... )* ]`. Crucially the *first*
        // token after `[` is an identifier (not a number, ']', or another '['). That
        // alone is enough to disambiguate against `[]T` (slice) and `[N]T` (array shape)
        // which appear in type positions, not after declaration names anyway.
        if Peek(1).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        // Also reject the corner case `[ Ident ]` where the bracketed segment
        // is followed by a token that would make it look like a type clause
        // (e.g. `[ Ident ] Ident` -> slice/array shape used somewhere we
        // shouldn't be). At a declaration header the follow-set after the TP
        // list is `(`, so we just look for that.
        //
        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): also skip `class`, `struct`, and `init()` constraint
        // tokens that may appear after the type-parameter name.
        var ahead = 2
        while true {
            let k = Peek(ahead).Kind
            if k == SyntaxKind.IdentifierToken ||
                k == SyntaxKind.ClassKeyword ||
                k == SyntaxKind.StructKeyword ||
                k == SyntaxKind
                .DotToken {
                // `init` is lexed as an identifier; consume an optional `()` pair
                // when this identifier is the contextual `init` constraint keyword.
                if k == SyntaxKind.IdentifierToken && Peek(ahead).Text == "init" && Peek(
                    ahead + 1
                ).Kind == SyntaxKind.OpenParenthesisToken &&
                    Peek(ahead + 2).Kind == SyntaxKind.CloseParenthesisToken {
                    ahead += 3
                    continue
                }
                // A `.` continues a qualified (dotted) constraint name
                // (e.g. `[T Namespace.Sub.IFace[T]]`); skip it and the segment
                // identifier that follows so the balanced `[ ... ]` and the
                // list-terminating `,`/`]` are examined against the right token.
                ahead++
                continue
            }
            // ADR-0089 / issue #943: a constraint identifier may carry a generic
            // type-argument list (e.g. the curiously-recurring `[T IComparable[T]]`).
            // Skip the balanced `[ ... ]` segment so the disambiguation following
            // it (a `,` between type parameters or the closing `]` of the whole
            // type-parameter list) is examined against the right token.
            if k == SyntaxKind.OpenSquareBracketToken {
                var depth = 0
                while true {
                    let inner = Peek(ahead).Kind
                    if inner == SyntaxKind.EndOfFileToken {
                        return false
                    }
                    if inner == SyntaxKind.OpenSquareBracketToken {
                        depth++
                    } else if inner == SyntaxKind.CloseSquareBracketToken {
                        depth--
                        if depth == 0 {
                            ahead++
                            break
                        }
                    }
                    ahead++
                }
                continue
            }
            break
        }
        if Peek(ahead).Kind == SyntaxKind.CommaToken {
            return true
        }
        if Peek(ahead).Kind == SyntaxKind.CloseSquareBracketToken {
            // Phase 4.1: function declarations follow `[T any]` with `(`.
            // Phase 4.3 / ADR-0020: type declarations follow `[T any]` with
            // `data`/`struct`/`class`/`interface` (contextual `data` lexes as
            // an identifier; the lookahead also covers the not-yet-supported
            // `interface` case for forward compatibility).
            let follow = Peek(ahead + 1)
            if follow.Kind == SyntaxKind.OpenParenthesisToken ||
                follow.Kind == SyntaxKind.StructKeyword ||
                follow.Kind == SyntaxKind.EnumKeyword ||
                follow.Kind == SyntaxKind.ClassKeyword ||
                follow.Kind == SyntaxKind.InterfaceKeyword ||
                follow.Kind == SyntaxKind.SealedKeyword ||
                follow.Kind == SyntaxKind.OpenKeyword ||
                follow.Kind == SyntaxKind.EqualsToken ||
                follow.Kind == SyntaxKind.OpenBraceToken ||
                follow.Kind == SyntaxKind.ColonToken ||
                (follow.Kind == SyntaxKind.IdentifierToken && (follow.Text == "data" || follow.Text == "record")) {
                return true
            }
        }
        return false
    }

    private func ParseTypeParameter() TypeParameterSyntax {
        var variance SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && (Current.Text == "in" || Current.Text == "out") && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            variance = NextToken()
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var constraint SyntaxToken? = nil
        var openBracket SyntaxToken? = nil
        var constraintTypeArgs SeparatedSyntaxList[TypeClauseSyntax]? = default(SeparatedSyntaxList[TypeClauseSyntax]?)
        var closeBracket SyntaxToken? = nil
        var constraintTypeClause TypeClauseSyntax? = nil
        if Current.Kind == SyntaxKind.IdentifierToken {
            // Reserve the `class`/`struct`/`init` constraints (handled below
            // as their own keyword tokens / `init`-contextual identifier) so
            // that we don't accidentally bind them as the legacy
            // any/comparable/interface-name slot.
            if !IsAdditionalConstraintStart(Current) {
                // A qualified (dotted) constraint name — e.g.
                // `Namespace.Sub.IFace[T]` — cannot be represented by the single
                // `constraint` identifier token. Parse the whole thing through the
                // regular type-clause machinery (which already handles dotted names
                // and per-segment generic arguments, stopping at the `,`/`]` that
                // closes the type-parameter list). The first-segment identifier is
                // retained in `constraint` for `any`/`comparable` dispatch and
                // error locations. cs2gs emits fully-qualified constraint names, so
                // this is the common shape for translated generic-math interfaces.
                if Peek(1).Kind == SyntaxKind.DotToken {
                    constraintTypeClause = ParseTypeClause()
                    constraint = constraintTypeClause.Identifier
                } else {
                    constraint = NextToken()
                    // ADR-0089 / issue #755: a constraint identifier may be followed by
                    // a generic type-argument list (the curiously-recurring pattern
                    // `[T IAdd[T]]` is the canonical generic-math shape required for
                    // static-virtual interface members). Parse `[ TypeClause (, TypeClause)* ]`
                    // when present; the binder constructs the closed interface from the
                    // resulting argument list.
                    if Current.Kind == SyntaxKind.OpenSquareBracketToken {
                        openBracket = MatchToken(SyntaxKind.OpenSquareBracketToken)
                        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
                        var parseNext = true
                        while parseNext &&
                            Current.Kind != SyntaxKind.CloseSquareBracketToken &&
                            Current.Kind != SyntaxKind
                            .EndOfFileToken {
                            nodesAndSeparators.Add(ParseTypeClause())
                            if Current.Kind == SyntaxKind.CommaToken {
                                nodesAndSeparators.Add(MatchToken(SyntaxKind.CommaToken))
                            } else {
                                parseNext = false
                            }
                        }
                        closeBracket = MatchToken(SyntaxKind.CloseSquareBracketToken)
                        constraintTypeArgs = SeparatedSyntaxList[TypeClauseSyntax](nodesAndSeparators.ToImmutable())
                    }
                }
            }
        }
        // ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
        // issue #997): consume any of `class`, `struct`, `init()` constraints
        // in any order. The binder validates illegal combinations (e.g.
        // `class struct`).
        var classKw SyntaxToken? = nil
        var structKw SyntaxToken? = nil
        var initKw SyntaxToken? = nil
        var initOpenParen SyntaxToken? = nil
        var initCloseParen SyntaxToken? = nil
        var unmanagedKw SyntaxToken? = nil
        while true {
            if Current.Kind == SyntaxKind.ClassKeyword {
                if classKw == nil {
                    classKw = NextToken()
                } else {
                    break
                }
            } else if Current.Kind == SyntaxKind.StructKeyword {
                if structKw == nil {
                    structKw = NextToken()
                } else {
                    break
                }
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "unmanaged" {
                // Issue #1336: contextual `unmanaged` constraint keyword.
                if unmanagedKw == nil {
                    unmanagedKw = NextToken()
                } else {
                    break
                }
            } else if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "init" && Peek(
                1
            ).Kind == SyntaxKind.OpenParenthesisToken &&
                Peek(2).Kind == SyntaxKind.CloseParenthesisToken {
                if initKw == nil {
                    initKw = NextToken()
                    initOpenParen = MatchToken(SyntaxKind.OpenParenthesisToken)
                    initCloseParen = MatchToken(SyntaxKind.CloseParenthesisToken)
                } else {
                    break
                }
            } else {
                break
            }
        }
        let typeParameter = TypeParameterSyntax(
            syntaxTree,
            variance,
            identifier,
            constraint,
            openBracket,
            constraintTypeArgs,
            closeBracket,
            classKw,
            structKw,
            initKw,
            initOpenParen,
            initCloseParen,
            unmanagedKw
        )
        if constraintTypeClause != nil {
            typeParameter.ConstraintType = constraintTypeClause
        }
        return typeParameter
    }

    /// ADR-0097 / issue #775 (constraint keyword renamed to `init()` by
    /// issue #997): returns `true` when
    /// [`token`](paramref) begins a flag-style constraint
    /// (`class`, `struct`, or `init(`). These are handled
    /// in a dedicated post-loop after the legacy single-identifier
    /// constraint slot is parsed (`any`, `comparable`, or a
    /// sealed-interface name).
    private func IsAdditionalConstraintStart(token SyntaxToken) bool {
        if token.Kind == SyntaxKind.ClassKeyword || token.Kind == SyntaxKind.StructKeyword {
            return true
        }
        // Issue #1336: contextual `unmanaged` constraint keyword.
        if token.Kind == SyntaxKind.IdentifierToken && token.Text == "unmanaged" {
            return true
        }
        if token.Kind == SyntaxKind.IdentifierToken && token.Text == "init" && Peek(
            1
        ).Kind == SyntaxKind.OpenParenthesisToken {
            return true
        }
        return false
    }

    // ADR-0149: a dedicated explicit-interface-implementation qualifier clause
    // `(InterfaceType)` immediately after a member keyword (`func`, `prop`,
    // `event`) — e.g. `func (IFoo) M(...)`, `prop (IFoo) P T`,
    // `prop (IFoo) this[...] T`, `event (IFoo) Changed T`. Reused across all
    // three member kinds via ParseOptionalExplicitInterfaceClause so the
    // grammar/parse logic lives in exactly one place.
    //
    // For `prop`/`event` there is no competing grammar (properties and events
    // never had a receiver-clause concept), so any `(` immediately following
    // the member keyword unambiguously starts this clause. For `func`, the
    // clause must be distinguished from the pre-existing Go-style receiver
    // clause (`func (recv RecvType) Name(...)`, ADR-0019): both start with
    // `(` IdentifierToken, so `LooksLikeExplicitInterfaceClause` must run
    // BEFORE `LooksLikeReceiverClause` and only claims the `(` when the token
    // right after the first identifier continues the SAME single type
    // reference — a qualified-name `.`, a generic-argument `[`, or the
    // immediate close `)` — rather than starting a second, distinct type
    // (which signals a receiver's "name Type" pair, e.g. `(recv IFoo)`).
    //
    // A single-token lookahead at the position right after the identifier is
    // NOT sufficient: `Identifier [` is ambiguous between a generic-argument
    // list on THAT SAME identifier (`IFoo[T]`, a one-type-reference explicit
    // interface clause) and the start of a receiver's array-shaped type,
    // where the identifier is the receiver NAME and `[...]T` is a SEPARATE,
    // second type (`(self []T)`, `(self [3]T)`). Both shapes begin with the
    // token sequence `(` Identifier `[`, so peeking only one token past the
    // identifier cannot tell them apart — speculatively scan a full type
    // clause instead (see below).
    private func LooksLikeExplicitInterfaceClause() bool {
        if Peek(0).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        if Peek(1).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        // Speculatively scan a single type clause starting right after the
        // `(`, reusing the same scanner already used to disambiguate generic
        // call sites elsewhere (TryScanTypeClause). An explicit-interface
        // clause contains EXACTLY one type reference — `IFoo`, `Ns.IFoo`, or
        // `IFoo[T]` — with nothing else before the closing `)`, so we only
        // commit to this interpretation when the scan succeeds AND lands
        // exactly on the closing `)` with nothing left over. A receiver's
        // array-shaped type (`self []T`, `self [3]T`) fails this scan
        // because `self` scans as a complete type on its own (a plain
        // identifier with no generic-argument list, since `[]`/`[3]` is not
        // a valid generic-argument list) and the scan position would then
        // land on `[`, not `)` — correctly falling through to the
        // receiver-clause heuristic instead.
        var pos = 1
        return TryScanTypeClause(&pos) && Peek(pos).Kind == SyntaxKind.CloseParenthesisToken
    }

    // ADR-0149: parses `(InterfaceType)` when present. The caller has already
    // confirmed (via LooksLikeExplicitInterfaceClause for `func`, or simply by
    // checking for `(` for `prop`/`event`, which have no competing grammar)
    // that the current token starts this clause.
    private func ParseExplicitInterfaceClause()(OpenParen SyntaxToken, Type TypeClauseSyntax, CloseParen SyntaxToken) {
        let openParen = MatchToken(SyntaxKind.OpenParenthesisToken)
        let type = ParseTypeClause()
        let closeParen = MatchToken(SyntaxKind.CloseParenthesisToken)
        return (openParen, type, closeParen)
    }

    private func LooksLikeExplicitExtensionReceiverClause() bool {
        if Peek(1).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        var ahead = 2
        if !TryScanParameterAnnotations(&ahead) || Peek(ahead).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        ahead++
        if !TryScanTypeClause(&ahead) || Peek(ahead).Kind != SyntaxKind.CloseParenthesisToken || Peek(
            ahead + 1
        ).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        let afterNameAhead = ahead + 2
        if Peek(afterNameAhead).Kind == SyntaxKind.OpenParenthesisToken {
            return true
        }
        // A generic extension method name (`Name[T](...)`) is also valid
        // here, but a bare `[` is ambiguous with an ordinary function's
        // return-type clause (`func extension(x T) List[int32] { ... }`,
        // where `List` is the return type's name, not the receiver-clause
        // method's — `extension` here is a plain function name). Scan the
        // bracketed region and require an actual parameter list to follow
        // before accepting it as a type-parameter list.
        var typeParameterListAhead = afterNameAhead
        return TryScanOptionalTypeArgumentList(&typeParameterListAhead, out var hasTypeParameterList) &&
            hasTypeParameterList &&
            Peek(typeParameterListAhead).Kind == SyntaxKind.OpenParenthesisToken
    }

    private func LooksLikeReceiverClause() bool {
        // Issue #751 (ADR-0084 L2): a receiver clause has the shape
        //   '(' annotation* ident <type-clause> ')' (ident | operator) ( '(' | '[' )
        // The original implementation hard-coded a tiny subset of type-clause
        // spellings (bare identifier, `[N]T` / `[]T`). That excluded common
        // shapes like `T?`, `sequence[T]`, `map[K,V]`, `(int, T)`, and
        // combinations thereof, silently demoting an extension-method
        // declaration to a malformed regular function. Rather than mirror
        // the entire type grammar here we scan the candidate receiver as a
        // balanced bracket region: find the matching `)` of the outer
        // parenthesis (bailing on a top-level `,` which would mean a
        // multi-parameter regular parameter list, never a receiver), and
        // then verify the trailing-token shape that distinguishes a
        // receiver clause from a regular parameter list. The actual type
        // grammar is validated when the receiver is parsed for real by
        // `ParseParameter` → `ParseTypeClause` — keeping the type grammar
        // in one place.
        if Peek(0).Kind != SyntaxKind.OpenParenthesisToken {
            return false
        }
        var ahead = 1
        if !TryScanParameterAnnotations(&ahead) || Peek(ahead).Kind != SyntaxKind.IdentifierToken {
            return false
        }
        ahead++
        var parenDepth = 1
        var bracketDepth = 0
        var closeParenAhead = -1
        while true {
            let kind = Peek(ahead).Kind
            if kind == SyntaxKind.EndOfFileToken {
                return false
            }
            // A top-level `,` means we have a multi-parameter regular
            // parameter list, not a single-parameter receiver clause.
            // Brackets (`[...]`) and inner parens nest freely; only
            // commas at the outer level disqualify.
            if parenDepth == 1 && bracketDepth == 0 && kind == SyntaxKind.CommaToken {
                return false
            }
            switch kind {
                case SyntaxKind.OpenParenthesisToken {
                    parenDepth++
                }
                case SyntaxKind.CloseParenthesisToken {
                    parenDepth--
                    if parenDepth == 0 {
                        closeParenAhead = ahead
                    }
                }
                case SyntaxKind.OpenSquareBracketToken {
                    bracketDepth++
                }
                case SyntaxKind.CloseSquareBracketToken {
                    bracketDepth--
                    if bracketDepth < 0 {
                        return false
                    }
                }
                default {
                    let _ = 0
                }
            }
            if closeParenAhead >= 0 {
                break
            }
            ahead++
        }
        // After the closing `)` we must see a function name (identifier or
        // the contextual `operator` keyword for operator-overload streams).
        ahead = closeParenAhead + 1
        let afterCloseKind = Peek(ahead).Kind
        if afterCloseKind != SyntaxKind.IdentifierToken && afterCloseKind != SyntaxKind.OperatorKeyword {
            return false
        }
        // Stream D: `operator <op>(` follows the receiver clause for operator
        // overloads. Accept any non-EOF token after `operator` here — the
        // operator-token validation happens in MatchOperatorOrIdentifier.
        if afterCloseKind == SyntaxKind.OperatorKeyword {
            return Peek(ahead + 1).Kind != SyntaxKind.EndOfFileToken && Peek(
                ahead + 2
            ).Kind == SyntaxKind.OpenParenthesisToken
        }
        // The parameter list opens with `(`, or — for a generic extension
        // function — a type-parameter list `[T]` precedes it (Phase 4.1).
        let afterNameKind = Peek(ahead + 1).Kind
        return afterNameKind == SyntaxKind.OpenParenthesisToken || afterNameKind == SyntaxKind.OpenSquareBracketToken
    }

    private func TryScanParameterAnnotations(ref ahead int32) bool {
        while Peek(ahead).Kind == SyntaxKind.AtToken {
            ahead++
            if Peek(ahead + 1).Kind == SyntaxKind.ColonToken &&
                (Peek(ahead).Kind == SyntaxKind.IdentifierToken || IsValidAnnotationTargetKind(Peek(ahead).Text)) {
                ahead += 2
            }
            if Peek(ahead).Kind != SyntaxKind.IdentifierToken {
                return false
            }
            ahead++
            while Peek(ahead).Kind == SyntaxKind.DotToken {
                ahead++
                if Peek(ahead).Kind != SyntaxKind.IdentifierToken {
                    return false
                }
                ahead++
            }
            if Peek(ahead).Kind == SyntaxKind.OpenSquareBracketToken {
                var bracketDepth = 0
                do {
                    let kind = Peek(ahead).Kind
                    if kind == SyntaxKind.EndOfFileToken {
                        return false
                    }
                    if kind == SyntaxKind.OpenSquareBracketToken {
                        bracketDepth++
                    } else if kind == SyntaxKind.CloseSquareBracketToken {
                        bracketDepth--
                    }
                    ahead++
                } while bracketDepth > 0
            }
            if Peek(ahead).Kind != SyntaxKind.OpenParenthesisToken {
                continue
            }
            var depth = 0
            do {
                let kind = Peek(ahead).Kind
                if kind == SyntaxKind.EndOfFileToken {
                    return false
                }
                if kind == SyntaxKind.OpenParenthesisToken {
                    depth++
                } else if kind == SyntaxKind.CloseParenthesisToken {
                    depth--
                }
                ahead++
            } while depth > 0
        }
        return true
    }

    private func ParseParameterList() SeparatedSyntaxList[ParameterSyntax] {
        let nodesAndSeparators = ImmutableArray.CreateBuilder[SyntaxNode]()
        var parseNextParameter = true
        while parseNextParameter &&
            Current.Kind != SyntaxKind.CloseParenthesisToken &&
            Current.Kind != SyntaxKind
            .EndOfFileToken {
            let parameter = ParseParameter()
            nodesAndSeparators.Add(parameter)
            if Current.Kind == SyntaxKind.CommaToken {
                let comma = MatchToken(SyntaxKind.CommaToken)
                nodesAndSeparators.Add(comma)
            } else {
                parseNextParameter = false
            }
        }
        return SeparatedSyntaxList[ParameterSyntax](nodesAndSeparators.ToImmutable())
    }

    private func ParseParameter() ParameterSyntax {
        // ADR-0047: parameter-level annotations precede the identifier.
        let annotations = ParseAnnotations()
        // ADR-0058 / issue #376: optional `scoped` contextual modifier precedes the identifier.
        // Disambiguate: `scoped` is only a modifier when followed by another identifier (the
        // parameter name). If the current token IS the parameter name (no following identifier),
        // treat it as the identifier, not as a modifier.
        var scopedModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken && Current.Text == "scoped" && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            scopedModifier = NextToken()
        }
        // ADR-0060: optional `ref`/`out`/`in` contextual modifier immediately precedes the
        // parameter identifier (after the optional `scoped`). Disambiguation rule: the
        // modifier is only consumed when the next token is an identifier (the parameter
        // name). If `ref` / `out` / `in` IS the parameter name (no following identifier),
        // treat it as the identifier itself.
        var refKindModifier SyntaxToken? = nil
        if Current.Kind == SyntaxKind.IdentifierToken &&
            (Current.Text == "ref" || Current.Text == "out" || Current.Text == "in") &&
            Peek(1).Kind == SyntaxKind.IdentifierToken {
            refKindModifier = NextToken()
        }
        // ADR-0101 / issue #799: the C# `params` keyword is intentionally NOT
        // part of the G# parameter grammar — the canonical variadic spelling
        // is `name ...T` (Go-style). Detect the C# pattern `params <ident>`
        // and emit a focused diagnostic (GS0363) before recovering by
        // skipping the keyword and continuing to parse the rest as a regular
        // parameter. This stops the user from hitting a cryptic "expected
        // identifier" error and points them at the canonical spelling.
        if Current.Kind == SyntaxKind.IdentifierToken && SyntaxFacts.IsParamsKeyword(Current.Text) && Peek(
            1
        ).Kind == SyntaxKind.IdentifierToken {
            let paramsToken = NextToken()
            Diagnostics.ReportParamsKeywordNotSupported(paramsToken.Location)
        }
        let identifier = MatchToken(SyntaxKind.IdentifierToken)
        var ellipsis SyntaxToken? = nil
        if Current.Kind == SyntaxKind.EllipsisToken {
            ellipsis = MatchToken(SyntaxKind.EllipsisToken)
        }
        let type = ParseTypeClause()
        // ADR-0063: optional default-value clause. Parsed as a general expression here;
        // the binder enforces the "compile-time constant representable in CLR parameter
        // metadata" rule and emits diagnostics on misuse.
        var equalsToken SyntaxToken? = nil
        var defaultValue ExpressionSyntax? = nil
        if Current.Kind == SyntaxKind.EqualsToken {
            equalsToken = NextToken()
            defaultValue = ParseExpression()
        }
        let parameter = ParameterSyntax(syntaxTree, identifier, ellipsis, type).WithAnnotations(annotations)
        parameter.ScopedModifier = scopedModifier
        parameter.RefKindModifier = refKindModifier
        parameter.EqualsToken = equalsToken
        parameter.DefaultValue = defaultValue
        return parameter
    }

    shared {
        // Issue #1278 / ADR-0131: parse the `-> expr` tail of an expression-bodied
        // member (free function, method, operator, conversion operator, property,
        // indexer, or property accessor) and synthesize an equivalent block body so
        // binding, lowering, async, and emit reuse the existing block-body path. A
        // body that yields a value (a getter, or a non-void function/property)
        // lowers to `{ return expr }` (asReturn == true); a value-less body (a void
        // function/method, or a set/init accessor) lowers to `{ expr }`, an
        // expression statement (asReturn == false). The synthesized braces reuse the
        // arrow's source position so diagnostics and spans stay anchored at the
        // member. G# spells this arrow `->` (RightArrowToken); the C# fat arrow `=>`
        // is never accepted.
        /// Issue #3907: whether an `async` function's return-type clause names
        /// the void-result await envelope — a bare `Task` or `ValueTask`
        /// with no type arguments — so an arrow body is an expression statement
        /// rather than a return.
        /// @remarks The test is deliberately syntactic and deliberately narrow: only
        /// `async` declarations are considered, only the two envelope names
        /// issue #1918 recognises, and only the unqualified, non-generic,
        /// non-nullable spelling. `Task[T]` / `ValueTask[T]` carry a
        /// result and keep their return; a nullable or qualified spelling is left
        /// alone rather than guessed at. A non-async function named the same way
        /// really does return a task value, so it is untouched.
        /// @param asyncModifier The `async` modifier token, if present.
        /// @param type The return-type clause.
        /// @returns Whether the arrow body should lower to an expression statement.
        private func IsAsyncVoidResultEnvelope(asyncModifier SyntaxToken?, type TypeClauseSyntax) bool {
            if asyncModifier == nil ||
                type.HasTypeArguments ||
                type.HasQualifier ||
                type.IsNullable ||
                type.Identifier is not{} identifier {
                return false
            }
            return (identifier.Text is "Task" or "ValueTask")
        }
    }
}
