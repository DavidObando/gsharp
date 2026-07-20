// <copyright file="CSharpToGSharpTranslator.Expressions.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator.Loading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace Cs2Gs.Translator;

public sealed partial class CSharpToGSharpTranslator
{
    private sealed partial class DeclarationVisitor
    {
        // Issue #1907: C#14's `field` contextual keyword inside a property
        // accessor is a distinct Roslyn node (FieldExpressionSyntax, NOT an
        // IdentifierNameSyntax) that binds to the compiler-synthesized backing
        // field of the enclosing property. TranslateProperty registers a real G#
        // field name for it before translating any accessor body, so by the time
        // this runs the lookup always succeeds for a property that legitimately
        // uses `field`.
        private GExpression TranslateFieldExpression(FieldExpressionSyntax fieldExpression)
        {
            if (this.context.GetSymbolInfo(fieldExpression).Symbol is IFieldSymbol { AssociatedSymbol: IPropertySymbol owner } &&
                this.state.FieldKeywordBackingFieldNames.TryGetValue(owner, out string backingName))
            {
                return new IdentifierExpression(backingName);
            }

            this.context.ReportUnsupported(
                fieldExpression,
                "the C#14 `field` keyword could not be resolved to its property's synthesized backing field (ADR-0115 §B).");
            return new IdentifierExpression("nil");
        }

        private GExpression TranslateIdentifierName(IdentifierNameSyntax identifier)
        {
            // A switch-expression property-pattern binding (`Circle { Radius: var r }`)
            // has no G# equivalent; references to the bound local are rewritten to a
            // member access on the arm's type-pattern designator (`circle.Radius`).
            if (this.state.PatternBindings.Count > 0 &&
                this.context.GetSymbolInfo(identifier).Symbol is { } boundSymbol &&
                this.state.PatternBindings.TryGetValue(boundSymbol, out GExpression replacement))
            {
                return replacement;
            }

            // Inside a lifted owned-struct receiver method (issue #938) a bare
            // reference to an instance member carries an implicit C# `this`; a
            // top-level receiver-clause `func` has no implicit receiver, so the
            // reference must be made explicit through the receiver (`self.X`).
            if (this.state.CurrentReceiverName != null)
            {
                ISymbol symbol = this.context.GetSymbolInfo(identifier).Symbol;
                if (symbol is { IsStatic: false } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property or SymbolKind.Method)
                {
                    return new MemberAccessExpression(
                        new IdentifierExpression(this.state.CurrentReceiverName),
                        SanitizeIdentifier(identifier.Identifier.Text));
                }
            }

            // A C# bare sibling static field/property reference (`FfAc3ChannelsTab`)
            // carries an implicit type qualifier. A G# top-level `func` (e.g. a
            // lifted extension method whose former `static class` keeps the field
            // in a `shared { }` block) or `shared` body has no implicit type scope,
            // so the reference must be qualified through the owning type
            // (`Ec3Extensions.FfAc3ChannelsTab`) — the field/property analog of the
            // bare static-call rule (ADR-0115 §B.18). Without this the binder reports
            // GS0125 (the name is not in scope at top level).
            if (this.context.GetSymbolInfo(identifier).Symbol is
                    { IsStatic: true, Kind: SymbolKind.Field or SymbolKind.Property } staticMember &&
                staticMember.ContainingType is { TypeKind: TypeKind.Class or TypeKind.Struct } owner &&
                !owner.IsImplicitlyDeclared &&
                !this.IsStaticUsingTarget(owner) &&
                !SymbolEqualityComparer.Default.Equals(owner.OriginalDefinition, this.entryType?.OriginalDefinition))
            {
                return new MemberAccessExpression(
                    this.StaticQualifierReceiver(owner, identifier.GetLocation()),
                    SanitizeIdentifier(identifier.Identifier.Text));
            }

            return new IdentifierExpression(SanitizeIdentifier(identifier.Identifier.Text));
        }

        // Builds the receiver expression used to qualify a bare sibling static
        // member reference through its owning type. For a non-generic owner this is
        // a plain identifier (`Owner`); for a GENERIC owner it must carry the type
        // arguments (`Owner[T]`) so it does not collide with a sibling non-generic
        // type of the same simple name (e.g. `static class TreeDecomposition` beside
        // `class TreeDecomposition<T>`), which would otherwise bind the arity-0 type
        // and report GS0158 for members that live only on the generic type.
        private GExpression StaticQualifierReceiver(INamedTypeSymbol owner, Location location)
        {
            if (owner.IsGenericType)
            {
                return new TypeExpression(this.typeMapper.Map(owner, this.context, location));
            }

            // Issue #2009: route the non-generic case through the same
            // `CSharpTypeMapper.QualifiedTypeName` logic the generic branch above
            // already uses (via `Map`), rather than the owner's bare simple name.
            // A top-level owner still prints as its bare (sanitized) name, but a
            // NESTED owner — e.g. the containing class of a C# 14 `extension`
            // block declared inside another type, or nested arbitrarily deep — is
            // qualified through its containing-type chain (`Outer.Inner`) whenever
            // its simple name collides with another source type, matching the
            // qualification the generic path already gets. Without this, a bare
            // nested owner name can bind the wrong homonymous type (or fail to
            // resolve at all) at the call site.
            GTypeReference mapped = this.typeMapper.Map(owner, this.context, location);
            string qualifiedName = mapped is NamedTypeReference named ? named.Name : owner.Name;
            return new IdentifierExpression(qualifiedName);
        }

        private GExpression TranslateLiteral(LiteralExpressionSyntax literal)
        {
            switch (literal.Kind())
            {
                case SyntaxKind.NumericLiteralExpression:
                    // Preserve the original literal spelling (ADR-0115 §B.12): G#
                    // has no implicit numeric promotion, so a C# `2.0` must stay
                    // `2.0` (not collapse to `2`, which would be int32 and fail
                    // `int32 * float64`); hex such as `0xFF0000` is likewise kept
                    // verbatim. The bound type still classifies the literal kind.
                    object value = literal.Token.Value;
                    if (value is float or double or decimal)
                    {
                        return LiteralExpression.Float(literal.Token.Text);
                    }

                    // C# applies an implicit int->double/float promotion at a
                    // call site (e.g. `M(30)` where the parameter is `double`).
                    // G# has no such implicit promotion, so the emitter would push
                    // an int32 where a float64 is expected and produce invalid IL
                    // (ilverify StackUnexpected). Honor the bound `ConvertedType`
                    // and emit a float literal so the value matches its target
                    // type (ADR-0115 §B.12).
                    if (this.IsConvertedToFloatingPoint(literal))
                    {
                        return LiteralExpression.Float(this.ToFloatLiteralText(literal.Token.Value));
                    }

                    return LiteralExpression.Int(this.NormalizeIntegerLiteralText(literal));

                case SyntaxKind.StringLiteralExpression:
                    return LiteralExpression.String(literal.Token.ValueText);

                case SyntaxKind.Utf8StringLiteralExpression:
                    // A UTF-8 string literal `"x"u8` is a `ReadOnlySpan<byte>` of
                    // the UTF-8 encoding of the text. G# has no `u8` suffix, so emit
                    // the canonical byte slice literal `[]uint8{ … }` (ADR-0115 §B).
                    return new ArrayLiteralExpression(
                        new NamedTypeReference("uint8"),
                        System.Text.Encoding.UTF8.GetBytes(literal.Token.ValueText)
                            .Select(b => (GExpression)LiteralExpression.Int($"0x{b:X2}"))
                            .ToList());

                case SyntaxKind.CharacterLiteralExpression:
                    return LiteralExpression.Char(literal.Token.ValueText);

                case SyntaxKind.TrueLiteralExpression:
                    return LiteralExpression.Bool(true);

                case SyntaxKind.FalseLiteralExpression:
                    return LiteralExpression.Bool(false);

                case SyntaxKind.NullLiteralExpression:
                    return LiteralExpression.Null();

                case SyntaxKind.DefaultLiteralExpression:
                    // The target-typed `default` literal maps to G# `default(T)`
                    // for the converted (target) type when that type is known, so
                    // the value is self-typed. A bare typeless `default` relies on
                    // surrounding context for its type, but common positions supply
                    // none: an inferred `var retval = default` (the C# type was
                    // erased to the initializer's natural type, which for `default`
                    // is the target type, so the local-declaration path omits the
                    // clause and infers — yet bare `default` has nothing to infer
                    // from) surfaces GS0362. Emitting `default(T)` keeps it valid
                    // everywhere (ADR-0100). Falls back to bare `default` only when
                    // the type is genuinely unavailable.
                    return new DefaultValueExpression(this.ResolveExpressionType(literal));

                default:
                    this.context.ReportUnsupported(
                        literal,
                        $"literal '{literal.Kind()}' has no canonical G# form yet; emitted nil (ADR-0115 §B.12).");
                    return LiteralExpression.Null();
            }
        }

        // C# infers the type of a suffix-less integer literal from its value: a
        // hex constant such as `0xD800000000000000` is implicitly `ulong`. G#'s
        // lexer instead defaults to int32/int64 and rejects an out-of-range
        // literal (GS0004), so when the bound value requires a wider/unsigned
        // type we append the matching G# suffix (`L`, `UL`, `U`).
        private string NormalizeIntegerLiteralText(LiteralExpressionSyntax literal)
        {
            string text = literal.Token.Text;
            object value = literal.Token.Value;

            // Respect an explicit suffix already present in the source spelling.
            if (text.Length > 0 && (text[text.Length - 1] is 'u' or 'U' or 'l' or 'L'))
            {
                return text;
            }

            switch (value)
            {
                case ulong:
                    return text + "UL";
                case long l when l > int.MaxValue || l < int.MinValue:
                    return text + "L";
                case uint u when u > int.MaxValue:
                    return text + "U";
                default:
                    return text;
            }
        }

        private bool IsConvertedToFloatingPoint(LiteralExpressionSyntax literal)
        {
            TypeInfo info = this.context.GetTypeInfo(literal);
            ITypeSymbol original = info.Type;
            ITypeSymbol converted = info.ConvertedType;
            if (converted is null || SymbolEqualityComparer.Default.Equals(original, converted))
            {
                return false;
            }

            bool originalIsIntegral = original is { SpecialType: SpecialType.System_SByte
                or SpecialType.System_Byte or SpecialType.System_Int16 or SpecialType.System_UInt16
                or SpecialType.System_Int32 or SpecialType.System_UInt32 or SpecialType.System_Int64
                or SpecialType.System_UInt64 };
            bool convertedIsFloat = converted.SpecialType is SpecialType.System_Single
                or SpecialType.System_Double;
            return originalIsIntegral && convertedIsFloat;
        }

        private string ToFloatLiteralText(object value)
        {
            // The token's *spelling* can be hex (`0xFF`), binary (`0b1010`),
            // digit-separated (`1_000`), or suffixed (`30L`); appending ".0" to
            // that raw text either produces an invalid G# float (`0xFF.0`,
            // `30L.0`) or silently misses cases that already contain a stray
            // 'e'/'E' hex digit (`0xAE`). Deriving the text from the token's
            // already-parsed *value* instead sidesteps spelling entirely: format
            // the numeric value as decimal and ensure it carries a fractional
            // part so the G# lexer classifies it as float64.
            double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            string text = number.ToString("R", CultureInfo.InvariantCulture);
            return text.IndexOfAny(new[] { '.', 'e', 'E' }) >= 0 ? text : text + ".0";
        }

        /// <summary>
        /// Translates a C# anonymous object creation (<c>new { A = 1, B = 2 }</c>)
        /// to a positional construction of a synthesized G# <c>data class</c>
        /// (<c>AnonymousType0(1, 2)</c>, issues #2282 and #2538). See
        /// <see cref="CSharpTypeMapper.GetOrCreateAnonymousDataClass"/> for why
        /// a synthesized, shape-deduplicated data class supersedes both the
        /// original positional-tuple lowering (issue #1934, which dropped
        /// member names) and the intermediate <c>object { }</c> anonymous-value
        /// literal (issue #2224, which cannot be spelled as an explicit TYPE —
        /// e.g. a lambda parameter's type inferred from another lambda's
        /// anonymous-typed return value, issue #2282's actual repro shape). A
        /// positional class construction — unlike a tuple literal — is legal
        /// inside an expression-tree lambda. It also remains a direct
        /// expression when used as a constructor-delegation argument; a class
        /// composite literal lowers to setup statements before the delegation
        /// and violates G#'s delegation-first rule (issue #2538).
        /// </summary>
        private GExpression TranslateAnonymousObjectCreation(AnonymousObjectCreationExpressionSyntax anonymous)
        {
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.AnonymousObjectCreationExpression),
                "anonymous object creation 'new { ... }' maps to positional construction of a synthesized G# 'data class' (issues #2282 and #2538); gsc reuses the same synthesized type for every structurally-identical anonymous-type shape, preserving named-member access at both the construction site and any type-position use.",
                anonymous.GetLocation(),
                TranslationSeverity.Info));

            GTypeReference syntheticType = this.context.GetTypeInfo(anonymous).Type is INamedTypeSymbol anonymousType
                ? this.typeMapper.GetOrCreateAnonymousDataClass(anonymousType, this.context, anonymous.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            var arguments = anonymous.Initializers
                .Select(i => this.TranslateExpression(i.Expression))
                .ToList();

            return BuildConstruction(syntheticType, arguments);
        }

        private GExpression TranslateMemberAccess(MemberAccessExpressionSyntax member)
        {
            // Issue #2351: a bare (non-invoked) reference to an extension
            // method's method group (e.g. assigned to a delegate) never goes
            // through TranslateInvocation, so track its declaring namespace
            // here too — otherwise a file relying on an implicit/global
            // `using` for that namespace would translate with no import.
            if (this.context.GetSymbolInfo(member).Symbol is IMethodSymbol { IsExtensionMethod: true } memberExtMethod)
            {
                this.typeMapper.TrackExtensionMethodNamespace(memberExtMethod);
            }

            // Issue #1879: a C# 14 extension-block member is declared on a
            // synthetic marker type (`INamedTypeSymbol.IsExtension`); rewrite its
            // call sites to the real emitted G# shape before falling into the
            // generic member-access translation below.
            if (this.context.GetSymbolInfo(member).Symbol is { } extSymbol
                && TryGetExtensionBlockOwner(extSymbol, out INamedTypeSymbol extOwner))
            {
                if (extSymbol.IsStatic)
                {
                    // A static extension member is accessed through the EXTENDED
                    // type's name (`string.Repeat(...)`, `string.Meaning`), but is
                    // emitted as a plain static member of the declaring class (no
                    // receiver-clause form exists for statics, ADR-0115 §B.19).
                    // Rewrite the qualifier to the real owner; the (predefined- or
                    // named-type) qualifier syntax on the C# side carries no value
                    // to translate. Issue #2009: use the same fully-qualified
                    // (nested-type-aware, generic-aware) owner receiver as a bare
                    // sibling static call/member (`StaticQualifierReceiver`),
                    // rather than the owner's bare simple name — a bare name is
                    // wrong when the extension block's containing class is nested
                    // inside another type or shares its simple name with another
                    // source type elsewhere in the compilation.
                    return new MemberAccessExpression(
                        this.StaticQualifierReceiver(extOwner, member.GetLocation()),
                        SanitizeIdentifier(member.Name.Identifier.Text));
                }

                if (extSymbol is IPropertySymbol)
                {
                    // `nameof(word.DoubledLength)` binds to the very same property
                    // symbol as an ordinary read, but `nameof` takes a name
                    // reference, not a value (G#'s NameOfExpression parses its
                    // argument as a plain expression and the binder rejects
                    // anything but a name/member-access/generic-name). Wrapping
                    // in a zero-arg call here would print `nameof(word.DoubledLength())`,
                    // which re-parses as a call and is rejected — leave the bare
                    // member access; its printed name is exactly the lowered
                    // func's name, so `nameof` still resolves correctly.
                    if (member.Parent is ArgumentSyntax nameOfArgument && IsNameOfArgument(nameOfArgument))
                    {
                        return new MemberAccessExpression(
                            this.TranslateExpression(member.Expression),
                            SanitizeIdentifier(member.Name.Identifier.Text));
                    }

                    // An instance extension property has no receiver-clause form
                    // in G#'s `prop` grammar and is lowered to a get-only
                    // receiver-clause `func` of the same name (ADR-0115 §B.19);
                    // a bare property read becomes a zero-argument call.
                    GExpression extReceiver = this.TranslateReceiverWithNullForgiveness(member.Expression);
                    return new InvocationExpression(
                        new MemberAccessExpression(extReceiver, SanitizeIdentifier(member.Name.Identifier.Text)),
                        new List<GExpression>(),
                        null);
                }

                // An instance extension METHOD needs no rewrite: it is emitted as
                // a receiver-clause `func`, which is invoked with the same
                // `receiver.Method(args)` call syntax as the C# source (exactly
                // like a classic `this T x` extension method), so it falls
                // through to the generic member-access translation below.
            }

            // Member access on a bare-identifier element access (`values[i].M`)
            // previously hit a G# parser ambiguity (#942); that gap is now fixed,
            // so the construct translates through the normal member-access path.
            //
            // When the member binds to an extension method whose `this` parameter
            // is itself nullable (`this T? x`), the method is *meant* to be invoked
            // on a possibly-null receiver and handles null internally (e.g.
            // `Ac4DsiV1.SampleRate()` over `static int? SampleRate(this Ac4DsiV1?)`).
            // Forgiving the receiver to non-null (`Ac4DsiV1!!`) changes its static
            // type to the non-null `Ac4DsiV1`, which gsc's extension-method lookup
            // does not match against the `Ac4DsiV1?` `this` slot (GS0159). Keep the
            // declared-nullable receiver so the extension resolves.
            // A C# nullable *value* type (`T?` lowering to `System.Nullable<T>`)
            // exposes `.Value` and `.HasValue`, but G# models a value-type `T?`
            // directly (no `Nullable<T>` member surface) and relies on Kotlin-style
            // smart-casts, so those members do not exist on the G# side. Rewrite
            // them to the idiomatic G# equivalents (#914):
            //   * `x.Value`    -> `x!!`      (assert non-null, matching C#'s throw-
            //                                 if-null semantics; harmless once the
            //                                 local is already smart-cast-narrowed).
            //   * `x.HasValue` -> `x != nil` (a plain null test on the raw receiver).
            // Guard on the receiver's *declared* type being `System.Nullable<T>` so
            // a user type with a member literally named `Value`/`HasValue` is
            // unaffected. Nullable *reference* types (`string?`) have a non-
            // `Nullable<T>` receiver type and are likewise left alone.
            if (this.context.GetTypeInfo(member.Expression).Type is { } receiverType
                && receiverType.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T)
            {
                switch (member.Name.Identifier.Text)
                {
                    case "Value":
                        return new NonNullAssertionExpression(this.TranslateExpression(member.Expression));
                    case "HasValue":
                        // Parenthesize the null test so it composes correctly
                        // under any surrounding operator. C# `!x.HasValue` would
                        // otherwise translate to `!x != nil`, which G# parses as
                        // `(!x) != nil` (GS0128); `!(x != nil)` is always correct.
                        return new ParenthesizedExpression(
                            new BinaryExpression(this.TranslateExpression(member.Expression), "!=", LiteralExpression.Null()));
                }
            }

            // Issue #2282 (was #2224, #1934): an anonymous-typed receiver (`new
            // { ... }`) is a C# reference type, so the flow-based passes below
            // would otherwise wrap it in a G# `!!` non-null assertion. The
            // receiver now lowers to a composite literal constructing a
            // synthesized `data class` — skip forgiveness for anonymous-type
            // receivers regardless: a `new { ... }` expression's own value can
            // never be null, so wrapping it would be meaningless (and,
            // historically, hit a gsc IL-emission gap for the earlier
            // value-type-based lowering this replaces).
            bool receiverIsAnonymousType =
                this.context.GetTypeInfo(member.Expression).Type is { IsAnonymousType: true };

            GExpression target = this.MemberBindsToNullableThisExtension(member) || receiverIsAnonymousType
                ? this.TranslateExpression(member.Expression)
                : this.TranslateReceiverWithNullForgiveness(member.Expression);
            string memberName = member.Name.Identifier.Text;

            // Issue #1905: C# pointer member access (`p->X`) and plain member
            // access (`p.X`) both parse as MemberAccessExpressionSyntax,
            // distinguished only by member.Kind() (PointerMemberAccessExpression
            // for `->`). gsc rejects a bare `p.X` on a pointer receiver
            // (GS0158) — but gsc's own G# grammar already has a native `->`
            // operator (sugar for `(*p).X`, ADR-0122 §4 / issue #1034) that its
            // parser desugars at parse time. Printing the arrow directly reuses
            // that existing, already-correct G# feature: it handles field,
            // property, and method-call receivers, chains (`a->b->c`, each
            // `->` recursing through this method) and lvalue targets
            // identically to `.`. (The hand-written `(*p).X` form the arrow
            // desugars to also round-trips as a *read*, but gsc's parser fails
            // to re-parse that explicit parenthesized form as an *assignment
            // target* — a separate, narrower parser gap the native `->` sugar
            // avoids entirely.)
            bool isArrow = member.IsKind(SyntaxKind.PointerMemberAccessExpression);

            // A C# tuple element access (`item.Name`, `item.Price`) lowers to the
            // positional G# tuple field `.Item1`/`.Item2`, because G# tuples are
            // positional and carry no element names (ADR-0115 §B.4). The default
            // `.ItemN` access already resolves; only named-element access needs the
            // rewrite, detected via the bound tuple-element field symbol.
            if (this.context.GetSymbolInfo(member).Symbol is IFieldSymbol field &&
                field.ContainingType is { IsTupleType: true })
            {
                IFieldSymbol positional = field.CorrespondingTupleField ?? field;
                memberName = positional.Name;
            }

            // Issue #2282 (was #2224): an anonymous-typed value (`new { A = 1,
            // B = 2 }`) now lowers to a composite literal constructing a
            // synthesized `data class` whose primary-constructor parameters
            // preserve real member names — no rewrite needed; `x.A` stays
            // `x.A` on the G# side, exactly like the C# anonymous-type property.
            return new MemberAccessExpression(target, SanitizeIdentifier(memberName), isArrow);
        }

        /// <summary>
        /// Translates a member- or element-access <paramref name="recv"/> receiver,
        /// wrapping it in G#'s postfix non-null assertion (<c>recv!!</c>) when the
        /// receiver is <em>declared</em> nullable (a <c>T?</c> reference type or
        /// nullable array) yet Roslyn's nullable <em>flow</em> analysis has proven
        /// it non-null at this site (e.g. after a guard such as
        /// <c>if (o.Child == null) return;</c>).
        /// </summary>
        /// <remarks>
        /// C# uses flow-sensitive null analysis, so a guarded nullable property or
        /// field chain reads as non-null afterwards. G# follows Kotlin-style
        /// smart-casts that narrow only <em>local</em> variables, never
        /// property/field-access chains, so emitting <c>Moov.TextTrack.Mdia</c>
        /// where <c>TextTrack</c> is <c>TrakBox?</c> is rejected with GS0158 (member
        /// access on a <c>T?</c> receiver) or GS0116 (indexing a <c>T?</c> receiver).
        /// Reusing Roslyn's own proof, the assertion <c>!!</c> re-establishes the
        /// non-null fact the guard already proved (#914). The assertion is harmless
        /// on an already-non-null receiver, but the predicate below stays precise to
        /// keep the output faithful.
        /// </remarks>
        /// <param name="recv">The immediate receiver expression (left of the
        /// <c>.</c> or <c>[</c>).</param>
        /// <returns>The translated receiver, wrapped in
        /// <see cref="NonNullAssertionExpression"/> when flow-proven non-null.</returns>
        private GExpression TranslateReceiverWithNullForgiveness(ExpressionSyntax recv)
        {
            GExpression translated = this.TranslateExpression(recv);

            if (this.ReceiverNeedsNullForgiveness(recv, isDereferenceReceiver: true)
                || this.ReceiverIsNullableReferenceFieldOrProperty(recv))
            {
                translated = new NonNullAssertionExpression(translated);
            }

            return ParenthesizeIfBareNumericLiteral(translated);
        }

        // ADR-0054: G#'s parser never chains postfix member/index/call access
        // directly onto a numeric-literal token (`42.ToString()`, `7.Squared()`)
        // because the lexer would otherwise have to guess whether `.` starts a
        // float's fractional part or a member access; the grammar resolves this by
        // simply disallowing the chain and requiring `(42).ToString()` instead. Any
        // receiver that renders as a bare int/float literal — decimal, hex, octal,
        // binary, or suffixed (`L`/`UL`/`F`/`D`/`M`) — therefore needs parentheses
        // wherever it is used as a member-access/call receiver; a non-literal
        // receiver (identifier, call, existing parenthesized expression, etc.) is
        // left untouched. A prefix unary on a numeric literal (`-5`, `+5`, `~5`)
        // still renders with a trailing numeric token, so it is treated the same
        // (e.g. `"x=" + -5` -> `(-5).ToString()`).
        private static bool IsBareNumericLiteral(GExpression expr) =>
            expr is LiteralExpression { Kind: LiteralKind.Int or LiteralKind.Float }
            || (expr is UnaryExpression u && IsBareNumericLiteral(u.Operand));

        private static GExpression ParenthesizeIfBareNumericLiteral(GExpression expr) =>
            IsBareNumericLiteral(expr) ? new ParenthesizedExpression(expr) : expr;

        /// <summary>
        /// True when a member-/element-access <paramref name="recv"/> receiver is a
        /// nullable-reference <em>field</em> or <em>property</em> (declared <c>T?</c>
        /// or promoted to nullable, issue #1072) and therefore always needs a G#
        /// <c>!!</c> assertion — independent of Roslyn flow state.
        /// </summary>
        /// <remarks>
        /// Unlike a local variable, G#'s Kotlin-style smart-casts never narrow a
        /// property/field-access chain, so <c>field.Member</c> / <c>field[i]</c> on a
        /// <c>T?</c> field is rejected (GS0158/GS0116) no matter what null-guard
        /// precedes it. The Oahu corpus compiles nullable-<em>disabled</em>, so
        /// Roslyn's flow analysis reports these receivers as oblivious (never
        /// flow-state <c>NotNull</c>) and the flow-driven
        /// <see cref="ReceiverNeedsNullForgiveness"/> pass leaves them bare.
        /// Asserting <c>field!!.Member</c> both compiles and preserves C#'s
        /// throw-on-null semantics for the same access (a null field would
        /// <c>NullReferenceException</c> in C# too). Locals/parameters keep the
        /// flow-proven path, since G# does smart-cast them; comparison operands and
        /// <c>?.</c> receivers are routed elsewhere and never reach this pass.
        /// </remarks>
        private bool ReceiverIsNullableReferenceFieldOrProperty(ExpressionSyntax recv)
        {
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            // Issue #2113: in a nullable-OBLIVIOUS compilation the whole-program
            // taint analysis may promote a LOCAL or PARAMETER receiver to `T?`.
            // gsc smart-casts locals only after a flow-proven guard (inert under
            // oblivious metadata), so an unguarded `x.Member` / `x[i]` / `for … in
            // x` on such a receiver is rejected (GS0158/GS0116). Assert `x!!` to
            // both compile and preserve C#'s throw-on-null semantics for the same
            // access. Gated to oblivious so nullable-enabled projects (whose
            // locals gsc DOES smart-cast) keep their flow-driven path untouched.
            if (this.IsObliviousCompilation()
                && symbol is ILocalSymbol or IParameterSymbol
                && this.ShouldPromoteToNullableReference(symbol))
            {
                return true;
            }

            // Issue #2113 follow-up: a value produced by an EXTERNAL (metadata)
            // member compiled WITHOUT a nullable context is oblivious — Roslyn
            // reports its reference-type return/type as `NullableAnnotation.None`
            // — and gsc maps every such oblivious external reference type to `T?`.
            // A method-call/property/field receiver like `searcher.Get()` (from an
            // unannotated package, e.g. System.Management) is therefore rejected on
            // `recv.Member` / `recv[i]` / `for … in recv` (GS0158/GS0116) even
            // though C# accepts it (it would `NullReferenceException` on null just
            // the same). Assert `recv!!` to compile and preserve that throw-on-null
            // behavior. Gated to oblivious so nullable-enabled projects — whose
            // external refs carry real annotations — are untouched.
            if (this.IsObliviousCompilation()
                && (IsObliviousExternalNullableMember(symbol)
                    || this.LocalInitializedFromObliviousExternalNullable(symbol)))
            {
                return true;
            }

            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
        }

        // Issue #2113: true for a nullable-oblivious compilation
        // (NullableContextOptions.Disable) — the only mode in which the
        // whole-program taint analysis runs and its declaration/receiver
        // adjustments apply. A nullable-enabled compilation is byte-identical to
        // pre-#2113 behavior.
        private bool IsObliviousCompilation() =>
            this.context.Compilation.Options.NullableContextOptions == NullableContextOptions.Disable;

        // Issue #2113 follow-up: true when <paramref name="symbol"/> is an EXTERNAL
        // (metadata) method/property/field whose reference-type return/type is
        // oblivious (<c>NullableAnnotation.None</c>, i.e. the declaring assembly was
        // compiled without a nullable context, e.g. System.Management). gsc maps
        // every such oblivious external reference type to <c>T?</c>, so a value
        // read from one is nullable from gsc's point of view. Restricted to
        // external symbols because a SOURCE symbol in an oblivious compilation is
        // also <c>None</c> but its nullability is decided by the whole-program
        // taint analysis instead, not treated as unconditionally nullable.
        private static bool IsObliviousExternalNullableMember(ISymbol symbol)
        {
            if (symbol is not (IMethodSymbol or IPropertySymbol or IFieldSymbol)
                || !symbol.DeclaringSyntaxReferences.IsDefaultOrEmpty)
            {
                return false;
            }

            // Use the member's ORIGINAL (unsubstituted) return/type: gsc maps a
            // member to `T?` based on the nullable context of the assembly that
            // DECLARES it, not on a type argument the consumer supplies. An
            // annotated BCL member like `IReadOnlyList<T>.this[int]` returns the
            // type parameter `T` (excluded below), so `list[i]` stays non-null even
            // in oblivious consumer code — only a member whose own declared return
            // is a concrete oblivious reference type (e.g. System.Management's
            // `ManagementObjectSearcher.Get()` -> `ManagementObjectCollection`) is
            // treated as nullable.
            ISymbol original = symbol.OriginalDefinition;
            ITypeSymbol type = original switch
            {
                IMethodSymbol m => m.ReturnType,
                IPropertySymbol p => p.Type,
                IFieldSymbol f => f.Type,
                _ => null,
            };

            return type is { IsReferenceType: true }
                and not ITypeParameterSymbol
                && type.NullableAnnotation == NullableAnnotation.None;
        }

        // Issue #2113 follow-up: true when <paramref name="symbol"/> is a `let`
        // local whose type is inferred from an initializer that reads an oblivious
        // external nullable member (e.g. `let coll = searcher.Get()`). gsc infers
        // such a local as `T?`, so a `coll.Member` / `for … in coll` use needs a
        // `!!` — but promoting the local's DECLARATION to `T?` cascades
        // nullable-conversion errors at its other (non-null) uses, so the
        // assertion is applied only here at the receiver/foreach-source use site.
        private bool LocalInitializedFromObliviousExternalNullable(ISymbol symbol)
        {
            if (symbol is not ILocalSymbol local)
            {
                return false;
            }

            foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
            {
                if (reference.GetSyntax() is VariableDeclaratorSyntax { Initializer.Value: { } initializer }
                    && IsObliviousExternalNullableMember(
                        this.context.GetSymbolInfo(initializer).Symbol))
                {
                    return true;
                }
            }

            return false;
        }

        // True when <paramref name="member"/> binds to an extension method whose
        // (reduced) `this` parameter is nullable-annotated (`this T? x`) or was
        // promoted nullable by oblivious analysis. Such a method is designed to
        // accept a null receiver, so the translated call must keep that nullable
        // receiver rather than forgive it to non-null.
        private bool MemberBindsToNullableThisExtension(MemberAccessExpressionSyntax member)
        {
            if (this.context.GetSymbolInfo(member).Symbol is not IMethodSymbol method)
            {
                return false;
            }

            IMethodSymbol unreduced = method.ReducedFrom ?? method;
            if (!unreduced.IsExtensionMethod || unreduced.Parameters.Length == 0)
            {
                return false;
            }

            IParameterSymbol thisParameter = unreduced.Parameters[0];
            return thisParameter.Type.IsReferenceType
                ? thisParameter.NullableAnnotation == NullableAnnotation.Annotated
                    || this.ShouldPromoteToNullableReference(thisParameter)
                : thisParameter.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T;
        }

        // Issue #1354: a value-position read (a `return` expression or a
        // conditional-expression arm) of a declared-`T?`/promoted-to-`T?` symbol
        // that Roslyn's flow analysis has narrowed to non-null needs a `!!`
        // assertion to satisfy a non-null target. G# does not smart-cast
        // property/field chains, so unlike the receiver pass this also covers
        // bare reads consumed as values (`return Continuation` /
        // `cond ? a : Continuation`). The shared <see cref="ReceiverNeedsNullForgiveness"/>
        // predicate already excludes null-comparison operands (flow there is not
        // NotNull), `?.` receivers, `this`/`base`, and literals.
        private GExpression TranslateValueWithNullForgiveness(ExpressionSyntax value)
        {
            GExpression translated = this.TranslateExpression(value);

            if (this.ReceiverNeedsNullForgiveness(value))
            {
                return new NonNullAssertionExpression(translated);
            }

            return translated;
        }

        // Issue #2511: element-access arguments are call-like value sinks too.
        // Apply the established forgiveness predicate only when Roslyn bound the
        // argument to a non-null reference parameter that cs2gs will keep
        // non-null. Arrays and numeric/string/span indices therefore stay on
        // their existing paths, explicitly nullable indexer contracts remain
        // untouched, and nullable-enabled projects receive no new assertions.
        // A genuinely null oblivious key follows the existing `!!` bridge
        // policy and fails at runtime before the index operation.
        private GExpression TranslateIndexArgumentWithNullForgiveness(ArgumentSyntax argument)
        {
            GExpression translated = this.TranslateExpression(argument.Expression);
            if (!this.IsObliviousCompilation()
                || !this.IndexArgumentTargetsNonNullableReference(argument)
                || !this.IndexArgumentValueNeedsNullForgiveness(argument.Expression))
            {
                return translated;
            }

            GExpression assertionOperand = argument.Expression is ConditionalExpressionSyntax
                or SwitchExpressionSyntax
                or ConditionalAccessExpressionSyntax
                    ? new ParenthesizedExpression(translated)
                    : translated;
            return new NonNullAssertionExpression(assertionOperand);
        }

        private bool IndexArgumentValueNeedsNullForgiveness(ExpressionSyntax value)
        {
            if (value is PostfixUnaryExpressionSyntax
                    { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                || this.IsWithinExpressionTreeLambda(value))
            {
                return false;
            }

            if (this.ReceiverNeedsNullForgiveness(value))
            {
                return true;
            }

            switch (value)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.IndexArgumentValueNeedsNullForgiveness(parenthesized.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenTrue)
                        || this.IndexArgumentValueNeedsNullForgiveness(conditional.WhenFalse);

                case SwitchExpressionSyntax switchExpression:
                    return switchExpression.Arms.Any(arm =>
                        this.IndexArgumentValueNeedsNullForgiveness(arm.Expression));

                case ConditionalAccessExpressionSyntax:
                    return true;
            }

            ISymbol symbol = this.context.GetSymbolInfo(value).Symbol;
            return symbol is IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol
                && this.IsNullablePromotedValue(value)
                && !this.IsDominatedByNullCheckGuard(value, symbol);
        }

        private bool IndexArgumentTargetsNonNullableReference(ArgumentSyntax argument)
        {
            if (this.context.SemanticModel.GetOperation(argument) is not IArgumentOperation
                {
                    Parameter: { } parameter,
                })
            {
                return false;
            }

            return this.ParameterWillRemainNonNullableReference(parameter);
        }

        private bool ParameterWillRemainNonNullableReference(IParameterSymbol parameter)
        {
            return this.TargetWillRemainNonNullableReference(parameter.Type, parameter);
        }

        /// <summary>
        /// Determines whether <paramref name="recv"/> needs a G# <c>!!</c>
        /// assertion because it is either a declared-nullable reference narrowed
        /// non-null by flow or an ordinary dereference receiver whose declaration
        /// was promoted nullable by oblivious analysis (see
        /// <see cref="TranslateReceiverWithNullForgiveness"/>).
        /// </summary>
        private bool ReceiverNeedsNullForgiveness(
            ExpressionSyntax recv,
            bool isDereferenceReceiver = false)
        {
            // `expr!` already lowers to a `NonNullAssertionExpression`; never
            // double-assert. `this`/`base`, a null literal, and a `?.` conditional
            // access receiver are handled by their own paths and are not
            // declared-nullable property/field chains.
            if (recv is PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression }
                or ThisExpressionSyntax
                or BaseExpressionSyntax
                or LiteralExpressionSyntax
                or ConditionalAccessExpressionSyntax)
            {
                return false;
            }

            // Issue #2496: `!!` is a runtime-only G# operator and therefore is
            // never representable inside an expression tree (GS0473). Use the
            // lambda's semantic converted type rather than call/constructor
            // syntax so this covers overload-selected Expression<TDelegate>
            // parameters, generic expression sinks, fluent APIs, and nested
            // quoted lambdas uniformly. A user-authored C# suppression (`expr!`)
            // has already returned above and still translates to `!!`, preserving
            // the compiler's expression-tree restriction diagnostic.
            if (this.IsWithinExpressionTreeLambda(recv))
            {
                return false;
            }

            // Issue #2504/#2496: a method group or lambda is the callable value
            // itself, never the nullable value produced by invoking it. External
            // oblivious-return forgiveness belongs at the callable's result
            // contract, not as `MethodGroup!!` on the delegate conversion seam.
            if (this.IsCallableValueExpression(recv))
            {
                return false;
            }

            // Issue #2506: the oblivious analysis promotes a same-project
            // method/property/indexer declaration when its VALUE can be null.
            // An ordinary C# dereference of that value still means
            // throw-on-null, so the corresponding G# receiver needs one `!!`.
            // Keep this receiver-only: a method group is the callable value
            // rather than its return, and a promoted call forwarded as a return
            // or argument must remain `T?` instead of being blanket-forgiven.
            if (isDereferenceReceiver && this.ReceiverValueIsPromotedNullable(recv))
            {
                return true;
            }

            // Issue #2164: the classic lazy-singleton pattern initializes a
            // nullable static/instance field (or auto-property) under a null
            // guard (`if (F == null) { F = new(); } ... return F;` / `F ??= …;`),
            // so `F` is provably non-null at every use dominated by the guard.
            // gsc (by design, Kotlin-style) smart-casts only LOCALS, never
            // fields/properties, so the guarded read `T? -> T` is rejected
            // (GS0155). The migrated corpus is nullable-OBLIVIOUS, so Roslyn's
            // flow state is empty and the flow-based path below never fires;
            // detect the guard from SYNTAX and assert `F!!` instead.
            if (this.IsLazyInitGuardedFieldUse(recv))
            {
                return true;
            }

            // Issue #2202: `if (F == null) {…} else { …F… }` / `F == null ? … : …F…`
            // (and the negated forms) narrow `F` to non-null on the guarded
            // branch — same syntactic-guard rationale as the lazy-init case
            // above, for a plain null-check guard instead of a lazy-init one.
            if (this.IsNullGuardNarrowedFieldUse(recv))
            {
                return true;
            }

            // Issue #2202 / #2412 (round 3): a nullable-tainted field/property
            // read as ANY arm of a conditional/switch expression, when that
            // conditional is the (possibly parenthesized) body of a property/
            // method whose return type was deliberately kept non-null by the
            // oblivious analyzer's property-contract / forwarding-exclusion
            // guardrail (#1354 / #2167). The original C# accepted this
            // implicitly (oblivious, no enforcement); cs2gs keeps the declared
            // return non-null (matching the sibling project's own contract, so
            // downstream consumers of the property/method are unaffected), so
            // forgiving each tainted arm is the minimal assertion needed to
            // compile the member without regressing safety or widening its
            // contract. This subsumes the original, narrower #2202 shape where
            // one arm happens to ALSO be null-guard-narrowed by the condition
            // (e.g. `Book is null ? Component : Book`, the Oahu.Data
            // `Conversion.BookCommon` shape) — that arm is separately asserted
            // by <see cref="IsNullGuardNarrowedFieldUse"/>, and this rule
            // additionally covers the case where NEITHER arm is guarded by the
            // condition at all (e.g. `Profile.PreAmazon ? HttpClientAudible :
            // HttpClientAmazon`, the Oahu.Core `AudibleApi.HttpClient` shape,
            // where the condition is an unrelated flag, not a null-check on
            // either arm).
            if (this.IsNullableTaintedArmOfReturnPreservingConditional(recv))
            {
                return true;
            }

            // Issue #2432: an UNCONDITIONAL (no ternary/switch, no null-check
            // guard) forward of a same-project promoted-nullable field / property
            // / local / parameter / method as the ENTIRE (possibly parenthesized)
            // body of a property/method whose own return type was deliberately
            // kept non-null by the very same property-contract / forwarding-
            // exclusion guardrail (#1354 / #2167) that left the forwarded value
            // tainted in the first place. The canonical shape is an EXPLICIT
            // interface property implementation that forwards to a same-project
            // concrete property promoted through unrelated flow (the exact
            // Oahu.Core shape: `Authorization` is promoted to `Authorization?`
            // because its constructor can receive a null from
            // `Authorization.Create`, but the explicit `IAuthorization
            // IProfile.Authorization => Authorization;` forwarder's own type stays
            // the non-null interface contract `IAuthorization`, since
            // `CollectInterfacePropertyEdges` never taints an explicit-impl
            // forwarder from the property it merely reads, and
            // `SeedPropertyLikeReturnTaint` excludes property-forwarding from
            // transitivity for exactly this reason). Unlike
            // <see cref="IsNullableTaintedArmOfReturnPreservingConditional"/>,
            // no sibling ternary arm exists to require — the guardrail
            // relationship alone (this value being the WHOLE return-preserving
            // body) is sufficient evidence gsc will reject the bare `T? -> T`
            // conversion (GS0155): the original C# accepted the same forward
            // implicitly (oblivious, unchecked), so asserting `!!` here is the
            // minimal bridge, not a widening of the interface contract.
            if (this.IsUnguardedForwardOfTaintedValueInReturnPreservingBody(recv))
            {
                return true;
            }

            // Issue #2496: once callable values stop borrowing their synthesized
            // method symbol's return taint, a runtime delegate lambda still needs
            // the old, legitimate bridge at its RESULT seam. Keep that bridge
            // narrowly target-typed to a non-null delegate return contract. The
            // expression-tree guard above deliberately excludes quoted lambdas.
            if (this.IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(recv))
            {
                return true;
            }

            // Issue #2434: the ARGUMENT-position counterpart of the rule just
            // above — an UNCONDITIONAL (no guard dominating this exact use)
            // forward of a same-project promoted-nullable value as a call-site
            // argument whose bound parameter is a genuine non-null reference
            // type cs2gs will not also promote. Covers ordinary calls, direct
            // delegate invocations, and conditional delegate invocations alike
            // (the exact Oahu.Core BookLibrary.gs:490 shape:
            // `callback?(tmp)` where `tmp` is `Conversion?` and the delegate
            // parameter is `IConversion`).
            if (this.IsUnguardedForwardOfTaintedValueAsArgument(recv))
            {
                return true;
            }

            // Issue #2202: a call (or property/field read) whose result comes from
            // an EXTERNAL (metadata) member compiled without a nullable context is
            // oblivious — Roslyn reports its reference-type return/type as
            // `NullableAnnotation.None` — and gsc maps every such oblivious
            // external reference type to `T?` (see ClrNullability.cs). When such a
            // value appears as a return/expression-body result in an oblivious
            // compilation, gsc will require `T?` but the C# source assigned no
            // nullability (oblivious); assert `!!` to bridge the gap. This mirrors
            // the RECEIVER-position handling in ReceiverIsNullableReferenceFieldOrProperty
            // (issue #2113) but for VALUE positions (return statements, expression
            // bodies). Restricted to oblivious compilations so nullable-enabled
            // projects — whose external refs carry real annotations — are untouched.
            if (this.IsObliviousCompilation()
                && IsObliviousExternalNullableMember(this.context.GetSymbolInfo(recv).Symbol))
            {
                return true;
            }

            // Issue #2412: a VALUE-position read (`return foo.Name;`,
            // `sink.Accept(foo.Name)`) of a field/property/parameter/local/method
            // declared in a REFERENCED SIBLING project (a separate
            // `CSharpCompilation`, loaded by `CSharpProjectLoader.
            // LoadProjectWithReferencesAsync`) that the sibling's OWN whole-
            // program taint fixpoint proved null-tainted. Unlike a same-project
            // tainted value — whose consuming property/method/local is itself
            // promoted to `T?` by THIS compilation's own `Compute()` edge walk
            // (issue #2167), so the value flows `T? -> T?` and needs no `!!` —
            // a foreign symbol can never seed an edge in this compilation's own
            // fixpoint (the tainting evidence lives only in the sibling's
            // syntax), so the consuming declaration's OWN type is never promoted
            // and the mismatch must be bridged here, at the read, instead. Gated
            // to a symbol whose `ContainingAssembly` differs from this
            // compilation's own assembly so every intra-project case (handled by
            // the existing promotion path above) is completely untouched.
            ISymbol foreignCandidate = this.context.GetSymbolInfo(recv).Symbol;
            if (this.IsObliviousCompilation()
                && foreignCandidate is IFieldSymbol or IPropertySymbol or IParameterSymbol or ILocalSymbol or IMethodSymbol
                && !SymbolEqualityComparer.Default.Equals(foreignCandidate.ContainingAssembly, this.context.Compilation.Assembly)
                && this.ShouldPromoteToNullableReference(foreignCandidate))
            {
                return true;
            }

            // Flow analysis must have proven the receiver non-null at this site.
            if (this.context.GetTypeInfo(recv).Nullability.FlowState != NullableFlowState.NotNull)
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(recv).Symbol;

            // Static member access (`Type.StaticMember`) and namespace-qualified
            // names carry a type/namespace receiver, not a value: never assert.
            if (symbol is ITypeSymbol or INamespaceSymbol or null)
            {
                return false;
            }

            // Inspect the receiver's *declared* type. The flow-collapsed
            // `Nullability.Annotation` reports NotAnnotated once flow proves
            // non-null, so it cannot distinguish a declared `T?` from a `T`; the
            // declaring symbol's type is the reliable source.
            ITypeSymbol declared = symbol switch
            {
                IPropertySymbol property => property.Type,
                IFieldSymbol field => field.Type,
                ILocalSymbol local => local.Type,
                IParameterSymbol parameter => parameter.Type,
                IMethodSymbol method => method.ReturnType,
                _ => null,
            };

            // Focus on the GS0158/GS0116 cases: nullable reference types and
            // nullable arrays. Nullable value types (`int?`) take the `.Value`/
            // `.HasValue` path and are left untouched.
            if (declared is not { IsReferenceType: true })
            {
                return false;
            }

            // A declared-nullable receiver (`T?`) flow-proven non-null needs `!!`.
            // A declared non-null receiver that this pass PROMOTED to `T?`
            // (issue #1072: null-checked param/field/local) is rendered nullable
            // too, so its flow-proven uses need the same assertion for consistency.
            return declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
        }

        private bool ReceiverValueIsPromotedNullable(ExpressionSyntax expression)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.ReceiverValueIsPromotedNullable(parenthesized.Expression);

                case CastExpressionSyntax cast:
                    ITypeSymbol castTarget = this.context.GetTypeInfo(cast.Type).Type;
                    ITypeSymbol castSource = this.context.GetTypeInfo(cast.Expression).Type;
                    return castTarget != null
                        && castSource != null
                        && this.context.Compilation.ClassifyConversion(castSource, castTarget).IsReference
                        && this.ReceiverValueIsPromotedNullable(cast.Expression);

                case AwaitExpressionSyntax awaited:
                    return this.AwaitedReceiverValueIsPromotedNullable(awaited.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.ReceiverValueIsPromotedNullable(conditional.WhenTrue)
                        || this.ReceiverValueIsPromotedNullable(conditional.WhenFalse);

                case SwitchExpressionSyntax switchExpression:
                    return switchExpression.Arms.Any(arm =>
                        this.ReceiverValueIsPromotedNullable(arm.Expression));

                // `a ?? b` is non-null whenever `b` is non-null; only the
                // fallback value can make the coalesced receiver nullable.
                case BinaryExpressionSyntax coalesce
                    when coalesce.IsKind(SyntaxKind.CoalesceExpression):
                    return this.ReceiverValueIsPromotedNullable(coalesce.Right);

                case InvocationExpressionSyntax invocation
                    when this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method:
                    // Method-return taint on Task<T>/ValueTask<T> widens the
                    // awaited T, not the non-null task envelope itself.
                    return !IsTaskLikeEnvelope(method.ReturnType)
                        && this.ShouldPromoteToNullableReference(method);

                case ElementAccessExpressionSyntax elementAccess:
                    return this.context.GetSymbolInfo(elementAccess).Symbol is IPropertySymbol indexer
                        && this.ShouldPromoteToNullableReference(indexer);

                case IdentifierNameSyntax:
                case MemberAccessExpressionSyntax:
                    ISymbol symbol = this.context.GetSymbolInfo(expression).Symbol;
                    return symbol is IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol
                        && this.ShouldPromoteToNullableReference(symbol);

                default:
                    return false;
            }
        }

        private bool AwaitedReceiverValueIsPromotedNullable(ExpressionSyntax expression)
        {
            switch (expression)
            {
                case ParenthesizedExpressionSyntax parenthesized:
                    return this.AwaitedReceiverValueIsPromotedNullable(parenthesized.Expression);

                case CastExpressionSyntax cast:
                    return this.AwaitedReceiverValueIsPromotedNullable(cast.Expression);

                case ConditionalExpressionSyntax conditional:
                    return this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenTrue)
                        || this.AwaitedReceiverValueIsPromotedNullable(conditional.WhenFalse);

                case InvocationExpressionSyntax invocation
                    when this.context.GetSymbolInfo(invocation).Symbol is IMethodSymbol method:
                    return IsTaskLikeEnvelope(method.ReturnType)
                        && this.ShouldPromoteToNullableReference(method);

                default:
                    return false;
            }
        }

        private static bool IsTaskLikeEnvelope(ITypeSymbol type)
        {
            if (type is not INamedTypeSymbol named
                || !named.IsGenericType
                || named.TypeArguments.Length != 1
                || named.Name is not ("Task" or "ValueTask"))
            {
                return false;
            }

            return named.ContainingNamespace.ToDisplayString() == "System.Threading.Tasks";
        }

        // Issue #2164: true when <paramref name="recv"/> reads a nullable
        // (`T?`) field/property that is lazily initialized under a dominating
        // null guard, so it is provably non-null here and needs an explicit
        // `!!` (gsc never smart-casts fields/properties). The decision is purely
        // syntactic because the migrated corpus compiles nullable-oblivious.
        private bool IsLazyInitGuardedFieldUse(ExpressionSyntax recv)
        {
            if (!this.TryGetEmittedNullableFieldOrProperty(recv, out ISymbol symbol))
            {
                return false;
            }

            return this.IsDominatedByLazyInitGuard(recv, symbol);
        }

        // Issue #2202: shared prerequisite for the lazy-init-guard and
        // null-check-guard `!!` heuristics below — <paramref name="recv"/> must
        // be a bare/qualified read of a field or property that G# actually
        // emits as `T?` (declared nullable, or promoted to nullable by the
        // oblivious taint analysis). A read that is itself the LHS of an
        // assignment, the operand of a null comparison, or a `nameof` argument
        // is handled by other paths and is never a value read a guard narrows.
        private bool TryGetEmittedNullableFieldOrProperty(ExpressionSyntax recv, out ISymbol symbol)
        {
            symbol = this.context.GetSymbolInfo(recv).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol))
            {
                symbol = null;
                return false;
            }

            // The field/property must be emitted `T?` in G# — either declared
            // nullable or promoted to nullable by this translator (the taint
            // analysis / #1072 null-usage rules). Otherwise there is no `T? -> T`
            // to forgive and asserting `!!` on a non-null value is wrong.
            ITypeSymbol declared = symbol switch
            {
                IFieldSymbol field => field.Type,
                IPropertySymbol property => property.Type,
                _ => null,
            };

            if (declared is not { IsReferenceType: true })
            {
                symbol = null;
                return false;
            }

            bool emittedNullable = declared.NullableAnnotation == NullableAnnotation.Annotated
                || this.ShouldPromoteToNullableReference(symbol);
            if (!emittedNullable)
            {
                symbol = null;
                return false;
            }

            return true;
        }

        // Walks outward from the statement containing <paramref name="use"/> to
        // the enclosing accessor/method boundary, looking for a preceding
        // statement (in the same block or an enclosing one, e.g. a `lock` body)
        // that lazily initializes <paramref name="symbol"/> to a non-null value.
        // Because a lazy-init guard leaves `symbol` non-null on BOTH the taken
        // and skipped paths, every later use it dominates is non-null.
        private bool IsDominatedByLazyInitGuard(ExpressionSyntax use, ISymbol symbol)
        {
            StatementSyntax useStatement = use.FirstAncestorOrSelf<StatementSyntax>();
            if (useStatement == null)
            {
                return false;
            }

            for (SyntaxNode node = useStatement; node != null; node = node.Parent)
            {
                if (node.Parent is BlockSyntax block)
                {
                    foreach (StatementSyntax statement in block.Statements)
                    {
                        if (statement == node)
                        {
                            break;
                        }

                        if (this.IsLazyInitGuardStatement(statement, symbol))
                        {
                            return true;
                        }
                    }
                }

                // Stop at the enclosing accessor / method / local-function body:
                // dominance across a member boundary is not analyzed here.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return false;
        }

        // True when <paramref name="statement"/> is one of the lazy-init guard
        // shapes that leaves <paramref name="symbol"/> non-null afterwards:
        //   • `if (F == null) { F = expr; }` / `if (F is null) { F = expr; }`
        //   • `F ??= expr;`
        // (`expr` must not itself be a `null` literal). Lock-wrapped variants are
        // covered because the enclosing walk descends into the `lock` body block.
        private bool IsLazyInitGuardStatement(StatementSyntax statement, ISymbol symbol)
        {
            switch (statement)
            {
                case IfStatementSyntax ifStatement
                    when this.IsNullCheckOf(ifStatement.Condition, symbol):
                    return this.AssignsSymbolNonNull(ifStatement.Statement, symbol);

                case ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax coalesce }
                    when coalesce.IsKind(SyntaxKind.CoalesceAssignmentExpression)
                    && this.BindsTo(coalesce.Left, symbol)
                    && !IsNullOrSuppressedNull(coalesce.Right):
                    return true;

                default:
                    return false;
            }
        }

        // `F == null` / `null == F` / `F is null` (the null-path condition of a
        // lazy-init guard), where `F` binds to <paramref name="symbol"/>.
        private bool IsNullCheckOf(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);

            switch (condition)
            {
                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.EqualsExpression):
                    return (IsNullLiteral(binary.Right) && this.BindsTo(binary.Left, symbol))
                        || (IsNullLiteral(binary.Left) && this.BindsTo(binary.Right, symbol));

                case IsPatternExpressionSyntax isPattern
                    when this.BindsTo(isPattern.Expression, symbol):
                    return IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is not UnaryPatternSyntax;

                default:
                    return false;
            }
        }

        // `F != null` / `null != F` / `F is not null` — the negation of
        // <see cref="IsNullCheckOf"/>, where `F` binds to <paramref name="symbol"/>.
        private bool IsNonNullCheckOf(ExpressionSyntax condition, ISymbol symbol)
        {
            condition = StripParentheses(condition);

            switch (condition)
            {
                case BinaryExpressionSyntax binary
                    when binary.IsKind(SyntaxKind.NotEqualsExpression):
                    return (IsNullLiteral(binary.Right) && this.BindsTo(binary.Left, symbol))
                        || (IsNullLiteral(binary.Left) && this.BindsTo(binary.Right, symbol));

                case IsPatternExpressionSyntax isPattern
                    when this.BindsTo(isPattern.Expression, symbol):
                    return IsNullConstantPattern(isPattern.Pattern)
                        && isPattern.Pattern is UnaryPatternSyntax;

                default:
                    return false;
            }
        }

        // Issue #2202: true when <paramref name="use"/> reads a nullable
        // (`T?`) field/property from within the branch of an enclosing
        // `if (F == null) {…} else { …F… }` / `if (F != null) { …F… }` statement
        // or `F == null ? … : …F…` / `F != null ? …F… : …` conditional expression
        // whose condition directly null-checks that same field/property — so
        // `F` is provably non-null on that branch, and gsc (by design,
        // Kotlin-style) never smart-casts fields/properties across the guard.
        // The migrated corpus is nullable-oblivious, so Roslyn's own flow state
        // is empty and the flow-based check below never proves this; the guard
        // is instead detected from SYNTAX, mirroring
        // <see cref="IsLazyInitGuardedFieldUse"/>.
        private bool IsNullGuardNarrowedFieldUse(ExpressionSyntax use)
        {
            if (!this.TryGetEmittedNullableFieldOrProperty(use, out ISymbol symbol))
            {
                return false;
            }

            return this.IsDominatedByNullCheckGuard(use, symbol);
        }

        // Issue #2202 / #2434: true when a null-check guard for <paramref
        // name="symbol"/> dominates <paramref name="use"/> — walking outward
        // from the use to find an enclosing `if (F == null) {…} else { …F… }` /
        // `if (F != null) { …F… }` statement, or `F == null ? … : …F…` /
        // `F != null ? …F… : …` conditional expression, whose condition
        // directly null-checks that same symbol. Originally scoped to the
        // field/property caller (<see cref="IsNullGuardNarrowedFieldUse"/>),
        // this walk is symbol-kind-agnostic and is reused as-is by the
        // argument-forwarding rule (#2434,
        // <see cref="IsUnguardedForwardOfTaintedValueAsArgument"/>), which
        // needs the identical textual-guard detection for a LOCAL/PARAMETER —
        // a guarded local is narrowed by gsc's own Kotlin-style smart-cast
        // exactly as a guarded field is narrowed here, syntactically, so a
        // single shared walk serves both callers.
        private bool IsDominatedByNullCheckGuard(ExpressionSyntax use, ISymbol symbol)
        {
            for (SyntaxNode node = use; node != null; node = node.Parent)
            {
                switch (node.Parent)
                {
                    // An `else` branch's statement is nested one level deeper
                    // than the `if` itself — its direct parent is the
                    // `ElseClauseSyntax`, not the `IfStatementSyntax`.
                    case ElseClauseSyntax elseClause
                        when elseClause.Parent is IfStatementSyntax ifStatement
                            && node == elseClause.Statement
                            && this.IsNullCheckOf(ifStatement.Condition, symbol):
                        return true;

                    case IfStatementSyntax ifStatement
                        when node == ifStatement.Statement
                            && this.IsNonNullCheckOf(ifStatement.Condition, symbol):
                        return true;

                    case ConditionalExpressionSyntax ternary
                        when node == ternary.WhenFalse
                            && this.IsNullCheckOf(ternary.Condition, symbol):
                        return true;

                    case ConditionalExpressionSyntax ternary
                        when node == ternary.WhenTrue
                            && this.IsNonNullCheckOf(ternary.Condition, symbol):
                        return true;
                }

                // Stop at the enclosing accessor / method / local-function /
                // lambda / arrow-body boundary: a guard cannot narrow a use
                // across a member boundary.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #2202 / #2412 (round 3): true when <paramref name="use"/> reads
        /// a nullable-tainted field/property as an arm of a conditional/switch
        /// expression whose enclosing property/method return type was
        /// deliberately preserved non-null (the oblivious-analyzer's
        /// property-contract / forwarding-exclusion guardrail, issues #1354 /
        /// #2167).
        /// </summary>
        /// <remarks>
        /// Scoping constraints that prevent this from becoming a blanket forgiveness:
        /// <list type="bullet">
        ///   <item>Oblivious compilation only (nullable-enabled projects untouched).</item>
        ///   <item><paramref name="use"/> must be a field/property emitted <c>T?</c>.</item>
        ///   <item>The conditional must be the (possibly parenthesized / return-wrapped)
        ///     entire body of the enclosing property/method.</item>
        ///   <item>The enclosing property/method's return type must NOT be promoted to
        ///     nullable — only the deliberate "return kept non-null" pattern qualifies.</item>
        /// </list>
        /// This deliberately does NOT require a sibling arm to already be
        /// null-guard-narrowed (the original #2202 scoping): a conditional's
        /// governing condition need not correlate with either arm's nullness at
        /// all (e.g. `Profile.PreAmazon ? HttpClientAudible : HttpClientAmazon`
        /// — a plain flag check, not a null-check on either arm — the real
        /// Oahu.Core `AudibleApi.HttpClient` shape). Every tainted arm of a
        /// conditional whose enclosing member's return type the guardrail
        /// refused to widen needs the same bridging assertion the guardrail's
        /// own design already anticipates (per <see cref="IsUnguardedForwardOfTaintedValueInReturnPreservingBody"/>'s
        /// unconditional counterpart) — restricting to only the "one sibling
        /// already guarded" subset left every OTHER unguarded shape unfixed
        /// without narrowing the class of members this rule can affect (that
        /// scope is controlled entirely by <see cref="IsBodyOfReturnPreservingMember"/>
        /// below, not by sibling-guard status).
        /// </remarks>
        private bool IsNullableTaintedArmOfReturnPreservingConditional(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            if (!this.TryGetEmittedNullableFieldOrProperty(use, out _))
            {
                return false;
            }

            // Walk upward (stripping parentheses) to find the enclosing
            // ConditionalExpressionSyntax or SwitchExpressionSyntax whose arm
            // this use belongs to, and confirm that the use IS an arm (not the
            // condition / governing expression).
            (ExpressionSyntax conditional, _) = this.FindEnclosingConditionalAndSiblings(use);
            if (conditional == null)
            {
                return false;
            }

            // The conditional must be the (possibly parenthesized / return-wrapped)
            // entire body of an enclosing property or method, and that member's
            // return type must NOT be promoted to nullable by the oblivious
            // analyzer (i.e., it was deliberately kept non-null).
            return this.IsBodyOfReturnPreservingMember(conditional);
        }

        // Issue #2432: true when <paramref name="use"/> is a same-project
        // field/property/local/parameter/method read that is ALREADY emitted
        // `T?` (declared nullable, or promoted by the whole-program oblivious
        // taint fixpoint — the same symbol-kind set `IsNullablePromotedValue`
        // inspects) AND is, itself, the ENTIRE (possibly parenthesized) body of
        // a property/method whose own declared type the analyzer deliberately
        // left non-null (<see cref="IsBodyOfReturnPreservingMember"/>, shared
        // unchanged with <see cref="IsNullableTaintedArmOfReturnPreservingConditional"/>).
        // This is the UNCONDITIONAL counterpart of that conditional-arm rule:
        // there is no ternary/switch here at all, so no arm can be evaluated —
        // the sole evidence is the guardrail relationship
        // itself (a promoted-nullable value flowing, unconditionally, into a
        // declaration the SAME analyzer refused to widen). That refusal is
        // deliberate for a contract member (explicit/implicit interface
        // implementation or override, which must keep the interface/base's own
        // declared nullability) and for an ordinary property that merely
        // forwards ANOTHER property (excluded from `SourceScope` transitivity to
        // preserve the #1354 golden forwarding behavior) — both leave the
        // bridging `!!` to this pass, exactly as their design comments call for.
        private bool IsUnguardedForwardOfTaintedValueInReturnPreservingBody(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(use).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol))
            {
                return false;
            }

            // Reuses the exact same "is this emitted `T?`" test the rest of the
            // translator relies on (declared-annotated OR taint-promoted), so a
            // symbol whose nullability this pass would forgive here is always
            // consistent with what every other promotion/forgiveness call site
            // already treats as nullable.
            if (!this.IsNullablePromotedValue(use))
            {
                return false;
            }

            return this.IsBodyOfReturnPreservingMember(use);
        }

        // Issue #2434: true when <paramref name="use"/> is a same-project
        // field/property/local/parameter/method read that is ALREADY emitted
        // `T?` (declared nullable, or promoted by the whole-program oblivious
        // taint fixpoint — the same <see cref="IsNullablePromotedValue"/> test
        // as the #2432 return-forwarding rule) AND is passed, UNGUARDED (no
        // dominating null-check guard for the same symbol —
        // <see cref="IsDominatedByNullCheckGuard"/>), as the (possibly
        // parenthesized) ENTIRE expression of a call-site argument whose bound
        // parameter is a genuine non-null reference type that cs2gs itself will
        // NOT also promote to nullable (<see cref="ShouldPromoteToNullableReference"/>).
        //
        // The canonical shape is the Oahu.Core BookLibrary case: a same-project
        // concrete `Conversion` local promoted to `Conversion?` by unrelated
        // constructor-parameter taint, forwarded as the sole argument of a
        // CONDITIONAL delegate invocation (`callback?(tmp)`) whose delegate
        // parameter type is the concrete class's own interface `IConversion` —
        // a fixed, external (`System.Action<T>`-shaped) function-type
        // parameter that can NEVER itself be promoted to nullable the way an
        // ordinary same-project method parameter can (contrast a plain
        // `Run(IConversion c)` call, whose OWN parameter the taint fixpoint
        // promotes to `IConversion?` in lockstep with the argument,
        // sidestepping the gap entirely). The same gap reaches a DIRECT
        // (non-conditional) delegate invocation, a lambda-typed local, and any
        // ordinary same-project call whose parameter the fixpoint happens not
        // to promote — this rule is scoped to the ARGUMENT SHAPE, not to
        // delegates specifically, so a single rule (reusing gsc's existing
        // explicit-nullable-unwrap-then-implicit-reference-widen composition
        // in `Conversion.Classify`, which already accepts `tmp!!` here) covers
        // every call form uniformly, matching #2432's "search existing
        // conversion helpers, don't special-case" guidance. Unlike
        // <see cref="IsUnguardedForwardOfTaintedValueInReturnPreservingBody"/>,
        // a GUARDED local at this same call site needs no help at all: gsc's
        // own Kotlin-style smart-cast already narrows a syntactically-guarded
        // local read, so <see cref="IsDominatedByNullCheckGuard"/> must find NO
        // guard for this rule to apply, keeping the forgiveness reserved for
        // the truly unconditional forward the original (oblivious) C# accepted
        // implicitly.
        private bool IsUnguardedForwardOfTaintedValueAsArgument(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation())
            {
                return false;
            }

            ISymbol symbol = this.context.GetSymbolInfo(use).Symbol;
            if (symbol is not (IFieldSymbol or IPropertySymbol or ILocalSymbol or IParameterSymbol or IMethodSymbol))
            {
                return false;
            }

            if (!this.IsNullablePromotedValue(use))
            {
                return false;
            }

            // Walk up through parentheses to the immediate syntactic parent:
            // this rule covers only a DIRECT (unwrapped) forward — a
            // ternary/switch arm or any other composed expression never
            // resolves to an ArgumentSyntax parent here and is intentionally
            // left to the return-preserving-body rule (or unhandled) instead.
            SyntaxNode node = use;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is not ArgumentSyntax argumentSyntax)
            {
                return false;
            }

            // A dominating guard means gsc's own smart-cast (locals) or the
            // sibling field/property rule (already checked earlier in
            // ReceiverNeedsNullForgiveness) already makes this use safe
            // without any help from this rule.
            if (this.IsDominatedByNullCheckGuard(use, symbol))
            {
                return false;
            }

            if (this.context.SemanticModel.GetOperation(argumentSyntax) is not IArgumentOperation argumentOperation
                || argumentOperation.Parameter is not { } parameter)
            {
                return false;
            }

            // If cs2gs will ALSO promote the bound parameter to nullable (the
            // ordinary same-project method case above), the argument already
            // widens `T? -> T?` with no `!!` required — forcing one here would
            // be superfluous, not incorrect. This ONLY applies when the
            // parameter is itself declared by SOURCE inside THIS compilation:
            // cs2gs can only ever change the rendered signature of a symbol it
            // is translating from source — an EXTERNAL/BCL parameter (e.g. the
            // synthesized `Invoke` of `System.Action<T>`/`System.Func<T,...>`)
            // is never re-emitted, so its declared type can never actually be
            // promoted, no matter what `ShouldPromoteToNullableReference`
            // reports for it. That check alone is NOT a reliable signal here:
            // `Canonical()` maps a CONSTRUCTED generic Invoke parameter (e.g.
            // `Action<IConversion>.Invoke(IConversion)`) back to the single
            // SHARED unbound-generic definition `Action<T>.Invoke(T)` — the
            // very same canonical key the whole-program fixpoint uses to
            // record evidence for the delegate-parameter-promotion feature
            // (`PromoteDelegateParameterInvokedWithNull`) — so the CURRENT
            // invocation being translated (a tainted argument passed to THIS
            // delegate call) is itself sufficient evidence to mark that
            // canonical key tainted, self-referentially, for EVERY `Action<T>`/
            // `Func<T,...>` call site in the whole compilation. Requiring
            // source-declared-in-this-compilation excludes that external
            // symbol category entirely and leaves the same-project method
            // case (whose parameter genuinely has a declaring syntax node
            // here) unaffected.
            return this.ParameterWillRemainNonNullableReference(parameter);
        }

        private bool IsUnguardedForwardOfTaintedValueAsRuntimeLambdaResult(ExpressionSyntax use)
        {
            if (!this.IsObliviousCompilation()
                || this.IsWithinExpressionTreeLambda(use)
                || this.FindResultLambda(use) is not { } lambda
                || this.GetLambdaTargetDelegateType(lambda) is not { DelegateInvokeMethod: { } invoke }
                || invoke.ReturnType is not { IsReferenceType: true }
                || invoke.ReturnType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            bool returnDeclaredInThisCompilation = invoke.DeclaringSyntaxReferences
                .Any(reference => this.context.Compilation.ContainsSyntaxTree(reference.SyntaxTree));
            if (returnDeclaredInThisCompilation
                && this.ShouldPromoteToNullableReference(invoke))
            {
                return false;
            }

            return this.IsNullablePromotedValue(use)
                || IsObliviousExternalNullableMember(this.context.GetSymbolInfo(use).Symbol);
        }

        private AnonymousFunctionExpressionSyntax FindResultLambda(ExpressionSyntax use)
        {
            SyntaxNode node = use;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            if (node.Parent is AnonymousFunctionExpressionSyntax expressionLambda
                && expressionLambda.Body == node)
            {
                return expressionLambda;
            }

            if (node.Parent is not ReturnStatementSyntax returnStatement)
            {
                return null;
            }

            for (SyntaxNode ancestor = returnStatement.Parent; ancestor != null; ancestor = ancestor.Parent)
            {
                if (ancestor is AnonymousFunctionExpressionSyntax lambda)
                {
                    return lambda;
                }

                if (ancestor is LocalFunctionStatementSyntax or BaseMethodDeclarationSyntax)
                {
                    return null;
                }
            }

            return null;
        }

        private bool IsWithinExpressionTreeLambda(SyntaxNode node) =>
            node.AncestorsAndSelf()
                .OfType<AnonymousFunctionExpressionSyntax>()
                .Any(lambda => this.IsExpressionTreeLambda(lambda));

        private bool IsExpressionTreeLambda(AnonymousFunctionExpressionSyntax lambda) =>
            this.context.GetTypeInfo(lambda).ConvertedType is INamedTypeSymbol converted
                && converted.IsGenericType
                && converted.OriginalDefinition.MetadataName == "Expression`1"
                && converted.ContainingNamespace?.ToDisplayString() == "System.Linq.Expressions"
                && converted.TypeArguments.Length == 1
                && converted.TypeArguments[0].TypeKind == TypeKind.Delegate;

        private INamedTypeSymbol GetLambdaTargetDelegateType(AnonymousFunctionExpressionSyntax lambda)
        {
            if (this.context.GetTypeInfo(lambda).ConvertedType is not INamedTypeSymbol converted)
            {
                return null;
            }

            if (converted.TypeKind == TypeKind.Delegate)
            {
                return converted;
            }

            return this.IsExpressionTreeLambda(lambda)
                ? converted.TypeArguments[0] as INamedTypeSymbol
                : null;
        }

        // Walks outward from <paramref name="use"/> through parentheses to find
        // the nearest enclosing ConditionalExpressionSyntax or
        // SwitchExpressionSyntax whose arm the use belongs to. Returns the
        // conditional and the sibling arms (all arms EXCEPT the one containing
        // <paramref name="use"/>). Returns (null, null) if not found.
        private (ExpressionSyntax Conditional, ExpressionSyntax[] Siblings)
            FindEnclosingConditionalAndSiblings(ExpressionSyntax use)
        {
            for (SyntaxNode node = use; node != null; node = node.Parent)
            {
                switch (node.Parent)
                {
                    case ConditionalExpressionSyntax ternary:
                        if (node == ternary.WhenTrue || IsDescendantOfArmViaParens(use, ternary.WhenTrue))
                        {
                            return (ternary, new[] { ternary.WhenFalse });
                        }

                        if (node == ternary.WhenFalse || IsDescendantOfArmViaParens(use, ternary.WhenFalse))
                        {
                            return (ternary, new[] { ternary.WhenTrue });
                        }

                        // The use is in the condition, not an arm.
                        return (null, null);

                    case SwitchExpressionSyntax switchExpr:
                        var siblings = new List<ExpressionSyntax>();
                        bool found = false;
                        foreach (SwitchExpressionArmSyntax arm in switchExpr.Arms)
                        {
                            if (arm.Expression == node || IsDescendantOfArmViaParens(use, arm.Expression))
                            {
                                found = true;
                            }
                            else
                            {
                                siblings.Add(arm.Expression);
                            }
                        }

                        return found ? (switchExpr, siblings.ToArray()) : (null, null);
                }

                // Stop at member boundary.
                if (node is AccessorDeclarationSyntax
                    or BaseMethodDeclarationSyntax
                    or LocalFunctionStatementSyntax
                    or AnonymousFunctionExpressionSyntax
                    or ArrowExpressionClauseSyntax)
                {
                    break;
                }
            }

            return (null, null);
        }

        // True when <paramref name="descendant"/> is nested inside
        // <paramref name="arm"/> through parenthesized expressions only.
        private static bool IsDescendantOfArmViaParens(SyntaxNode descendant, ExpressionSyntax arm)
        {
            for (SyntaxNode node = descendant; node != null; node = node.Parent)
            {
                if (node == arm)
                {
                    return true;
                }

                if (node.Parent is not ParenthesizedExpressionSyntax && node != descendant)
                {
                    return false;
                }
            }

            return false;
        }

        // True when <paramref name="conditional"/> is the (possibly parenthesized
        // / return-wrapped) entire body of a property or method whose declared
        // return type was NOT promoted to nullable by the oblivious-nullability
        // analyzer — i.e., the analyzer deliberately preserved it non-null.
        private bool IsBodyOfReturnPreservingMember(ExpressionSyntax conditional)
        {
            // Walk up through parentheses and a single return statement to reach
            // the enclosing arrow-body / accessor / method boundary.
            SyntaxNode node = conditional;
            while (node.Parent is ParenthesizedExpressionSyntax)
            {
                node = node.Parent;
            }

            ISymbol enclosingMember = null;

            // Case 1: arrow-expression body `=> expr`
            if (node.Parent is ArrowExpressionClauseSyntax arrow)
            {
                enclosingMember = arrow.Parent switch
                {
                    PropertyDeclarationSyntax p => this.context.GetDeclaredSymbol(p),
                    IndexerDeclarationSyntax i => this.context.GetDeclaredSymbol(i),
                    MethodDeclarationSyntax m => this.context.GetDeclaredSymbol(m),
                    AccessorDeclarationSyntax acc
                        when acc.Parent?.Parent is BasePropertyDeclarationSyntax bp
                        => this.context.GetDeclaredSymbol(bp),
                    _ => null,
                };
            }
            else if (node.Parent is ReturnStatementSyntax ret)
            {
                // Case 2: `return expr;` inside a block-bodied getter/method —
                // walk up from the return statement to the enclosing member.
                enclosingMember = this.FindEnclosingPropertyOrMethodSymbol(ret);
            }

            if (enclosingMember == null)
            {
                return false;
            }

            // The member's return type must be reference-typed and NOT promoted
            // to nullable — confirming the analyzer deliberately kept it non-null.
            ITypeSymbol returnType = enclosingMember switch
            {
                IPropertySymbol p => p.Type,
                IMethodSymbol m => m.ReturnType,
                _ => null,
            };

            if (returnType is not { IsReferenceType: true })
            {
                return false;
            }

            if (returnType.NullableAnnotation == NullableAnnotation.Annotated)
            {
                return false;
            }

            // If the oblivious analyzer DID promote this member to nullable,
            // the return type is already `T?` and forgiving the arm is unnecessary
            // (and would be wrong — the caller expects nullable).
            return !this.ShouldPromoteToNullableReference(enclosingMember);
        }

        // Walks up from a return statement to find the enclosing property (via a
        // `get` accessor) or method symbol. Stops at nested scope boundaries
        // (lambdas, local functions). Returns null if not found.
        private ISymbol FindEnclosingPropertyOrMethodSymbol(ReturnStatementSyntax ret)
        {
            for (SyntaxNode walk = ret.Parent; walk != null; walk = walk.Parent)
            {
                switch (walk)
                {
                    case AccessorDeclarationSyntax acc
                        when acc.IsKind(SyntaxKind.GetAccessorDeclaration)
                            && acc.Parent?.Parent is BasePropertyDeclarationSyntax bp:
                        return this.context.GetDeclaredSymbol(bp);

                    case MethodDeclarationSyntax m:
                        return this.context.GetDeclaredSymbol(m);

                    case LocalFunctionStatementSyntax:
                    case AnonymousFunctionExpressionSyntax:
                        return null;
                }
            }

            return null;
        }

        // True when <paramref name="body"/> (a lazy-init guard's then-branch)
        // contains an assignment of a non-null value to <paramref name="symbol"/>.
        private bool AssignsSymbolNonNull(StatementSyntax body, ISymbol symbol)
        {
            if (body == null)
            {
                return false;
            }

            foreach (AssignmentExpressionSyntax assignment in
                body.DescendantNodesAndSelf().OfType<AssignmentExpressionSyntax>())
            {
                if (!assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                    && !assignment.IsKind(SyntaxKind.CoalesceAssignmentExpression))
                {
                    continue;
                }

                if (this.BindsTo(assignment.Left, symbol)
                    && !IsNullOrSuppressedNull(assignment.Right))
                {
                    return true;
                }
            }

            return false;
        }

        private static ExpressionSyntax StripParentheses(ExpressionSyntax expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren)
            {
                expression = paren.Expression;
            }

            return expression;
        }
    }
}
