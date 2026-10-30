// <copyright file="CSharpToGSharpTranslator.Declarations.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import GSharpIdentifierNameContext = GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Microsoft.CodeAnalysis.CSharp.Syntax
import Microsoft.CodeAnalysis.Operations
import Microsoft.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        /// Removes and returns top-level declarations collected while translating
        /// the most recent aggregate, so the document translator can emit them as
        /// siblings.
        /// @returns The collected top-level declarations (possibly empty).
        func DrainPendingTopLevel() IReadOnlyList[GMember] {
            if this.state.PendingTopLevelDeclarations.Count == 0 {
                return Array.Empty[GMember]()
            }
            let drained = List[GMember](this.state.PendingTopLevelDeclarations)
            this.state.PendingTopLevelDeclarations.Clear()
            return drained
        }

        override func VisitEnumDeclaration(node Microsoft.CodeAnalysis.CSharp.Syntax.EnumDeclarationSyntax) GMember {
            let symbol ISymbol? = this.context.GetDeclaredSymbol(node)
            let cases = List[EnumCase]()
            // Issue #1912 N1: reinterpret each constant's bits per the C# enum's
            // OWN underlying type (byte/short/int/long and their unsigned
            // counterparts) via the shared `ToEnumBitPattern` helper (also used by
            // `MapEnumConstant`) rather than `Convert.ToInt64` directly —
            // `Convert.ToInt64` throws `OverflowException` on a `ulong` constant
            // above `long.MaxValue` (e.g. a `[Flags] enum X : ulong` high-bit
            // member), which would otherwise crash the translator.
            let underlyingType = (symbol as INamedTypeSymbol)
                ?.EnumUnderlyingType
                ?.SpecialType ??
                SpecialType.System_Int32
            // Issue #1912: explicit case values (`Banana = 2`, `Unknown = -1`, a
            // `[Flags]` bit-combination, or an alias like `DefaultError =
            // ServerError`) must survive translation — a plain re-numbering
            // silently changes the runtime int32 value. The semantic model has
            // already constant-folded every member (including alias references
            // and bitwise-OR flag combinations) onto `IFieldSymbol.ConstantValue`,
            // so we read the resolved value directly rather than re-parsing the
            // C# initializer expression; only members whose resolved value
            // diverges from the default auto-numbered ordinal need an explicit
            // `= value` in the emitted G# (matching C# §19.4's own auto-numbering
            // continuation rule for the members that follow an explicit one).
            var nextOrdinal = 0
            for member in node.Members {
                let memberSymbol ISymbol? = this.context.GetDeclaredSymbol(member)
                var explicitValue int32? = nil
                if this.context.GetDeclaredSymbol(member) is IFieldSymbol{HasConstantValue: true} fieldSymbol {
                    // Issue #2005: a signed `long`-range check on the raw bit
                    // pattern (`signedBits < int.MinValue || > int.MaxValue`)
                    // incorrectly drops legitimate top-bit-set values of 32-bit
                    // (and narrower) unsigned underlying types — e.g. `enum X :
                    // uint { High = 1u << 31 }` produces `signedBits ==
                    // 2147483648L`, which is a positive `long` above
                    // `int.MaxValue` even though its low 32 bits are a perfectly
                    // valid (negative) int32 bit pattern. `byte`/`sbyte`/`short`/
                    // `ushort`/`int`/`uint` (width <= 32) always fit in int32 once
                    // reinterpreted this way, since only their low 32 bits are
                    // ever meaningful; only a genuine 64-bit (`long`/`ulong`)
                    // value whose high 32 bits aren't the sign-extension of its
                    // low 32 bits truly has no int32 spelling.
                    let bits = ToEnumBitPattern(fieldSymbol.ConstantValue, underlyingType)
                    let candidate = unchecked(int32(uint32(bits)))
                    let is64BitWidth = underlyingType == SpecialType.System_Int64 ||
                        underlyingType == SpecialType.System_UInt64
                    let fitsInt32 = !is64BitWidth || unchecked(uint64(int64(candidate))) == bits
                    if !fitsInt32 {
                        // G# enums are always int32-backed (issue #1912 doesn't
                        // extend to non-default underlying types); a value outside
                        // int32 range has no faithful G# spelling, so fall back to
                        // the (already-wrong, but non-crashing) auto-numbered
                        // ordinal and flag it visibly rather than silently.
                        this.context.Report(
                            TranslationDiagnostic(
                                "EnumMemberDeclaration",
                                "enum case '${member.Identifier.Text}' has a constant value outside the int32 range G# enums support; the value is dropped.",
                                member.GetLocation(),
                                TranslationSeverity.Info
                            )
                        )
                        nextOrdinal++
                        cases.Add(EnumCase(this.EmittedName(memberSymbol, member.Identifier.ValueText)))
                        continue
                    }
                    let constantValue = candidate
                    if constantValue != nextOrdinal {
                        explicitValue = constantValue
                    }
                    nextOrdinal = constantValue + 1
                } else {
                    nextOrdinal++
                }
                cases.Add(
                    EnumCase(this.EmittedName(memberSymbol, member.Identifier.ValueText), explicitValue: explicitValue)
                )
            }
            return EnumDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                cases,
                MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists)
            )
        }

        override func DefaultVisit(node Microsoft.CodeAnalysis.SyntaxNode) GMember? {
            this.context.ReportUnsupported(
                node,
                "'${node.Kind()}' has no canonical G# declaration mapping; recorded for triage (ADR-0115 §B)."
            )
            return nil
        }

        /// T3 (ADR-0115 §B.1/§B.11): translates the C# program entry point's
        /// enclosing static class into top-level G#. The entry method's body
        /// becomes top-level statements (the G# program entry), and every other
        /// static method becomes a top-level `func`. The class itself — and
        /// any `shared { }` wrapping — is dropped.
        /// @param node The entry point's enclosing type declaration.
        /// @param entryPoint The bound entry-point method symbol.
        /// @returns The hoisted top-level funcs and the entry top-level statements.
        func TranslateEntryType(node TypeDeclarationSyntax, entryPoint IMethodSymbol?)(
            Funcs IReadOnlyList[GNode],
            Statements IReadOnlyList[GNode]
        ) {
            this.context.Report(
                TranslationDiagnostic(
                    "ClassDeclaration",
                    "C# entry point '${entryPoint!!.ContainingType.Name}.${entryPoint!!.Name}' and its enclosing static class are hoisted to top level: the entry body becomes top-level statements and sibling static methods become top-level 'func's (no 'shared { }' block) (ADR-0115 §B.1/§B.11 / T3).",
                    node.GetLocation(),
                    TranslationSeverity.Info
                )
            )
            let funcs = List[GNode]()
            let statements = List[GNode]()
            for member in node.Members {
                switch member {
                    case method is MethodDeclarationSyntax when SymbolEqualityComparer.Default.Equals(
                        this.context.GetDeclaredSymbol(method),
                        entryPoint
                    ) {
                        // Issue #1904: `Main`'s own `string[]` parameter may be
                        // named anything (`args`, `arguments`, …), but the
                        // top-level statements it is hoisted into only ever
                        // declare the fixed, implicit `args` slot (ADR-0066
                        // D1). Bind every reference to Main's parameter to that
                        // identifier — the same patternBindings substitution
                        // used for pattern-bound locals — for the duration of
                        // the entry body's translation only.
                        let renamedArgs = entryPoint!!
                            .Parameters
                            .Length == 1 &&
                            entryPoint!!
                            .Parameters[0]
                            .Name != "args"
                        if renamedArgs {
                            this.state.PatternBindings[entryPoint!!.Parameters[0]] = IdentifierExpression("args")
                        }
                        let body = this.TranslateBody(method, "entry point '${entryPoint!!.Name}'")
                        statements.AddRange(body.Statements)
                        if renamedArgs {
                            this.state.PatternBindings.Remove(entryPoint!!.Parameters[0])
                        }
                    }
                    case method is MethodDeclarationSyntax {
                        let (func_, _) = this.TranslateMethod(method, TypeDeclarationKind.Class)
                        if func_ != nil {
                            funcs.Add(func_)
                        }
                    }
                    default {
                        this.context.ReportUnsupported(
                            member,
                            "member '${member.Kind()}' of the entry class has no top-level G# mapping yet (ADR-0115 §B.11 / T3)."
                        )
                    }
                }
            }
            return (funcs, statements)
        }

        /// Issue #2382: translates a native C# top-level-statements program
        /// (Roslyn's `GlobalStatementSyntax` members, with no enclosing
        /// class/method syntax at all — as opposed to (cref:TranslateEntryType),
        /// which hoists an EXPLICIT `Main` method's body) directly to G#
        /// top-level statements. G# already has native top-level-statement
        /// support (ADR-0066) with the exact same shape: an implicit `args`
        /// binding, top-level `await`, and a top-level `return` —
        /// so the translation is a straight statement-by-statement mapping
        /// through the SAME (cref:TranslateStatement)/
        /// (cref:HoistCallBeforeDeclLocalFunctions(BlockSyntax)) seams a
        /// method body uses, not a second parallel statement translator.
        ///
        /// A top-level local function that captures no sibling top-level local
        /// (and does not read the implicit `args` parameter) is hoisted
        /// OUT to its own top-level G# `func` sibling declaration (see
        /// (cref:TranslateTopLevelLocalFunctionAsFunc)) — G# funcs are
        /// pre-declared in binding scope regardless of textual order (ADR-0066),
        /// so this also gives such a local function unrestricted forward-
        /// reference support, unlike the ordered `let`-binding fallback used for
        /// a genuinely capturing local function (which keeps the existing
        /// call-before-decl hoist behavior, issue #2231).
        /// @param globalStatements Every top-level `GlobalStatementSyntax` in this file, in source order.
        /// @param entryPoint The synthesized top-level-statements entry-point method symbol.
        /// @returns The hoisted top-level funcs (capture-free local functions) and the entry's top-level
        /// statements.
        func TranslateTopLevelProgram(
            globalStatements IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax],
            entryPoint IMethodSymbol?
        )(Funcs IReadOnlyList[GNode], Statements IReadOnlyList[GNode]) {
            this.context.Report(
                TranslationDiagnostic(
                    "GlobalStatement",
                    "C# native top-level statements are translated directly to G# top-level statements (ADR-0066): a capture-free top-level local function is hoisted to a sibling top-level 'func', and a capturing one keeps its ordered 'let' binding among the statements (issue #2382).",
                    globalStatements[0].GetLocation(),
                    TranslationSeverity.Info
                )
            )
            let flatStatements = globalStatements.Select(
                (gs Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax) -> gs.Statement
            )
                .ToList()
            let enclosingSpan = TextSpan.FromBounds(flatStatements[0].SpanStart, flatStatements[^1].Span.End)
            let ordered = this.HoistCallBeforeDeclLocalFunctions(flatStatements, enclosingSpan)
            // Issue #1904 (mirrored here): the synthesized top-level entry
            // point's own implicit parameter is always literally named "args"
            // (there is no C# source spelling to rename it from — unlike an
            // explicit `Main(string[] arguments)` — since the parameter is not
            // written by hand at all), but the rename guard is kept for
            // defense-in-depth in case a future Roslyn version ever changes
            // that assumption.
            let argsParameter IParameterSymbol? = entryPoint!!.Parameters.FirstOrDefault()
            // Issue #4197: a top-level local function that
            // `IsTopLevelLocalFunctionCaptureFree` will hoist to its own
            // top-level `func` (below) must NEVER be claimed by the capturing
            // registration pass — that pass's nullable-function-local scheme
            // (`var Name (…)? = nil` + `Name!!(…)` call sites) is for locals
            // that stay `let`-bound among the statements; a hoisted sibling
            // `func` is natively pre-declared (ADR-0066) and needs no such
            // scheme, and mixing the two rewrites the call site to `!!`
            // against a plain `func` declaration (GS0582). Filtering these
            // out here is exactly right, not just a workaround: once hoisted,
            // such a function is never at risk of the forward-reference
            // problem the nullable scheme exists to solve, so it plays no
            // part in ANY partner's SCC/reachability analysis either.
            //
            // PR #4200 review follow-up: `IsTopLevelLocalFunctionCaptureFree`
            // only inspects a CANDIDATE's own body for a captured sibling
            // local/`args` — it has no idea whether the candidate CALLS
            // another top-level local function that itself stays behind as a
            // statement-local `let` binding (because THAT one genuinely
            // captures). Hoisting such a candidate independently leaves its
            // emitted `func` body referencing a name with no sibling `func`
            // declaration to find — the callee is a statement-scoped `let`/
            // nullable-var, not a pre-declared sibling. So the initial
            // per-function hoist set is shrunk to a FIXED POINT: repeatedly
            // drop any still-hoisted candidate that calls a sibling top-level
            // local function symbol not itself (currently) in the hoisted set,
            // until a pass removes nothing. A self-call doesn't count (plain
            // recursion inside a genuine `func` already works natively).
            // Everything that drops out here flows into
            // `RegisterCapturingRecursiveLocalFunctions` below exactly like a
            // function that was never a hoist candidate in the first place —
            // that pass (widened by #4197 to claim every `group.Count > 1`
            // SCC) picks the pair back up.
            let topLevelLocalFunctions = ordered.OfType[LocalFunctionStatementSyntax]().ToList()
            let topLevelLocalFunctionsBySymbol = Dictionary[IMethodSymbol, LocalFunctionStatementSyntax](
                SymbolEqualityComparer.Default
            )
            for candidate in topLevelLocalFunctions {
                if this.context.GetDeclaredSymbol(candidate) is IMethodSymbol candidateSymbol {
                    topLevelLocalFunctionsBySymbol[candidateSymbol] = candidate
                }
            }
            let topLevelHoistedStatements = HashSet[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax](
                topLevelLocalFunctions.Where(
                    (candidate LocalFunctionStatementSyntax) -> this.IsTopLevelLocalFunctionCaptureFree(
                        candidate,
                        argsParameter,
                        enclosingSpan
                    )
                )
            )
            var shrank = true
            while shrank {
                shrank = false
                for candidate in topLevelLocalFunctions {
                    if !topLevelHoistedStatements.Contains(candidate) {
                        continue
                    }
                    let callsNonHoistedSibling = candidate
                        .DescendantNodes()
                        .Select((node Microsoft.CodeAnalysis.SyntaxNode) -> this.context.GetSymbolInfo(node).Symbol)
                        .OfType[IMethodSymbol]()
                        .Any(
                        (dependency IMethodSymbol) -> topLevelLocalFunctionsBySymbol.TryGetValue(
                            dependency,
                            out var dependencyDecl
                        ) &&
                            !object.ReferenceEquals(dependencyDecl, candidate) && !topLevelHoistedStatements.Contains(
                            dependencyDecl
                        )
                    )
                    if callsNonHoistedSibling {
                        topLevelHoistedStatements.Remove(candidate)
                        shrank = true
                    }
                }
            }
            let retainedLocalStatements = ordered.Where(
                (statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) -> !topLevelHoistedStatements.Contains(
                    statement
                )
            )
                .ToList()
            this.RegisterCapturingRecursiveLocalFunctions(retainedLocalStatements)
            this.RegisterRecursiveLocalFunctionLifts(retainedLocalStatements)
            let renamedArgs = argsParameter != nil && argsParameter.Name != "args"
            if renamedArgs {
                this.state.PatternBindings[argsParameter!!] = IdentifierExpression("args")
            }
            let funcs = List[GNode]()
            let statements = List[GNode]()
            // Issue #4239: every other body owner (method, constructor, lambda,
            // local function — see `TranslateBody`) sets `CurrentBodyScope` to
            // itself before translating its contents, so `IsLocalReassigned`'s
            // scope walk (`IsSymbolReassigned`) sees writes anywhere in that
            // body, including inside a nested local function. The top-level-
            // statements entry point has no single enclosing body syntax node to
            // reuse for that, but it has an equivalent: the compilation unit
            // root, which contains every global statement (and everything
            // nested inside them) as descendants. Left unset (null), a plain
            // top-level `int value = 0;` mutated only by a sibling local
            // function was never seen as reassigned — `IsSymbolReassigned`
            // short-circuits to `false` on a null scope — so it was always
            // emitted as an immutable `let`, later rejected by gsc as GS0127
            // once the local function's assignment compiled against it.
            let previousBodyScope Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope
            this.state.CurrentBodyScope = globalStatements[0].SyntaxTree.GetRoot()
            try {
                for statement in ordered {
                    if statement is LocalFunctionStatementSyntax localFunction && this.context.GetDeclaredSymbol(
                        localFunction
                    ) is IMethodSymbol localSymbol &&
                        topLevelHoistedStatements
                        .Contains(localFunction) {
                        let hoisted GMember? = this.TranslateTopLevelLocalFunctionAsFunc(localFunction, localSymbol)
                        if hoisted != nil {
                            funcs.Add(hoisted)
                            continue
                        }
                    }
                    statements.AddRange(this.TranslateStatement(statement))
                }
            } finally {
                this.state.CurrentBodyScope = previousBodyScope
                if renamedArgs {
                    this.state.PatternBindings.Remove(argsParameter!!)
                }
            }
            return (funcs, statements)
        }

        // G# keywords and parser-reserved declaration spellings come from the
        // compiler's canonical SyntaxFacts source.
        private func SanitizeIdentifier(name string) string {
            var name = name
            if string.IsNullOrEmpty(name) {
                return name
            }
            // C# verbatim identifiers (`@default`, `@class`) carry a leading `@`
            // in their syntax text; G# has no verbatim-identifier escape, so strip
            // it before the reserved-word check (the bare name is then suffixed if
            // it still collides with a G# keyword).
            if name[0] == '@' {
                name = name.Substring(1)
            }
            return this.nameAllocator.GetName(name)
        }

        private func EmittedName(
            symbol ISymbol?,
            fallbackName string?,
            context GSharpIdentifierNameContext = GSharpIdentifierNameContext.General
        ) string? {
            if symbol == nil {
                return this.nameAllocator.GetName(fallbackName, context)
            }
            if symbol is IDiscardSymbol {
                return fallbackName
            }
            return this.nameAllocator.GetName(symbol, context)
        }

        private func EmittedName(
            node Microsoft.CodeAnalysis.SyntaxNode?,
            token Microsoft.CodeAnalysis.SyntaxToken,
            context GSharpIdentifierNameContext = GSharpIdentifierNameContext.General
        ) string? {
            let symbol ISymbol? = this.context.GetDeclaredSymbol(node) ?? this.context.GetSymbolInfo(node).Symbol
            // Issue #4350 (review): a static/virtual/override get-only
            // auto-property is lowered to a private backing field plus an arrow
            // getter so it keeps C#'s setter-less ABI. C# only lets such a
            // property be written in its declaring constructor or initializer,
            // and every such write targets the backing field.
            if symbol is IPropertySymbol property &&
                IsWriteTarget(node) &&
                this
                .IsBackingFieldLoweredGetOnlyAutoProperty(property) {
                return this.RegisterSynthesizedPropertyBackingField(property, primaryCtorParamNames: nil)
            }
            return this.EmittedName(symbol, token.ValueText, context)
        }

        // Issue #4350 (review): a C# get-only auto-property that G# cannot
        // spell as a get-only auto-property. A body-less `open`/`override`
        // `{ get; }` declares an abstract slot, and G# has no static-constructor
        // body, so these lower to a synthesized private backing field plus an
        // arrow getter instead of gaining an ABI-visible `init` setter.
        private func IsBackingFieldLoweredGetOnlyAutoProperty(property IPropertySymbol?) bool {
            if property!!.SetMethod != nil ||
                property!!.GetMethod == nil ||
                property!!.IsAbstract ||
                property!!.IsIndexer ||
                property!!
                .ContainingType
                ?.TypeKind == TypeKind.Interface {
                return false
            }
            return property!!
                .DeclaringSyntaxReferences
                .Select((reference SyntaxReference) -> reference.GetSyntax())
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]()
                .Any(
                (syntax Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax) -> IsGetOnlyAutoProperty(
                    syntax
                ) &&
                    (
                    property!!.IsStatic ||
                        property!!.IsVirtual ||
                        property!!.IsOverride ||
                        (property!!.ContainingType?.IsRecord == true && syntax.Initializer != nil) ||
                        IsExplicitPositionalAutoProperty(syntax, property)
                )
            )
        }

        // Issue #2382: whether `localFunction` — declared among the top-level
        // statements — captures NOTHING from its top-level-statement siblings
        // (no sibling local, no reference to the implicit `args` parameter).
        // Such a local function can be hoisted to a genuine, independently
        // orderable top-level `func` (see <see cref="TranslateTopLevelLocalFunctionAsFunc"/>);
        // one that DOES capture a sibling must stay an in-place, ordered `let`
        // binding (the existing <see cref="HoistCallBeforeDeclLocalFunctions(BlockSyntax)"/>
        // forward-reference reordering already handles that case exactly like
        // an ordinary method body's captured local function).
        private func IsTopLevelLocalFunctionCaptureFree(
            localFunction LocalFunctionStatementSyntax,
            argsParameter IParameterSymbol?,
            enclosingSpan TextSpan
        ) bool {
            // A `static` local function can never capture in C# (CS8421) — the
            // language guarantees this shape is already capture-free, so no
            // body walk is needed.
            if localFunction.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) {
                return true
            }
            for id in localFunction.DescendantNodes().OfType[IdentifierNameSyntax]() {
                let symbol ISymbol? = this.context.GetSymbolInfo(id).Symbol
                if argsParameter != nil && SymbolEqualityComparer.Default.Equals(symbol, argsParameter) {
                    // References the entry point's own implicit `args` — a
                    // hoisted top-level `func` is a sibling declaration with no
                    // implicit access to it, so this must stay an in-place
                    // closure instead.
                    return false
                }
                if symbol is not ILocalSymbol local {
                    continue
                }
                for reference in local.DeclaringSyntaxReferences {
                    let declaration = reference.GetSyntax()
                    if localFunction.Span.Contains(declaration.Span) {
                        // Its own local (recursion, a nested block, ...) — fine.
                        continue
                    }
                    if enclosingSpan.Contains(declaration.Span) {
                        // Captures a sibling top-level statement's local.
                        return false
                    }
                }
            }
            return true
        }

        // Issue #2382: translates a CAPTURE-FREE top-level local function into
        // its own top-level G# `func` sibling declaration — reusing the exact
        // same parameter/return-type/type-parameter mapping and the same
        // <see cref="TranslateBody"/> seam an ordinary method or the sibling
        // static methods of an explicit `Main`'s enclosing class already use
        // (<see cref="TranslateEntryType"/>), rather than the `let`-bound
        // function-LITERAL form <see cref="TranslateLocalFunction"/> emits for
        // an in-place/capturing local function.
        private func TranslateTopLevelLocalFunctionAsFunc(
            localFunction LocalFunctionStatementSyntax,
            symbol IMethodSymbol
        ) GMember {
            let isAsync = localFunction.Modifiers.Any(
                (m Microsoft.CodeAnalysis.SyntaxToken) -> m.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword
                )
            )
            let parameters = this.MapParameters(symbol, localFunction.ParameterList, skipFirst: false)
            let returnType GTypeReference? = this.MapDelegateLikeReturnType(
                symbol,
                isAsync,
                localFunction.ReturnType.GetLocation()
            )
            let typeParameters = this.MapMethodTypeParameters(symbol)
            let body = this.TranslateBody(localFunction, "top-level local function '${localFunction.Identifier.Text}'")
            // A genuine top-level `func` declaration (unlike the function-LITERAL
            // form a non-hoisted local function lowers to) DOES support G#'s
            // native `ref` return modifier (ADR-0060/issue #490), so hoisting
            // incidentally lifts the "ref-returning local function has no
            // canonical form" gap (issue #1900) that still applies to a
            // captured/non-hoisted local function.
            return MethodDeclaration(
                this.EmittedName(symbol, localFunction.Identifier.ValueText),
                parameters,
                returnType,
                body,
                typeParameters,
                isAsync: isAsync,
                isRefReturn: symbol.ReturnsByRef || symbol.ReturnsByRefReadonly,
                isReadOnlyRefReturn: symbol.ReturnsByRefReadonly
            )
        }

        /// Issue #1201 / ADR-0134: whether [`owner`](paramref) is a type
        /// brought into unqualified static scope by a `using static`
        /// directive in this document. Bare references to such a type's static
        /// members are emitted unqualified (gsc hoists them through the bare
        /// type import) rather than qualified through the owning type name.
        /// @param owner The static member's containing type.
        /// @returns `true` when the owner is a `using static` target.
        private func IsStaticUsingTarget(owner INamedTypeSymbol?) bool -> owner != nil &&
            this
            .staticUsingTargets
            .Contains(owner.OriginalDefinition)

        private func MapVisibility(
            symbol ISymbol?,
            context TranslationContext,
            node Microsoft.CodeAnalysis.SyntaxNode?
        ) Visibility {
            if symbol == nil {
                return Visibility.Default
            }
            switch symbol.DeclaredAccessibility {
                case Accessibility.Public {
                    // public is the canonical default for both top-level and member
                    // positions, so it is omitted (ADR-0115 §B.10).
                    return Visibility.Default
                }
                case Accessibility.Private {
                    // Issues #4301/#4472: a kept top-level Program can also
                    // declare extension methods, but its
                    // remaining members still need `internal` so hoisted
                    // top-level statements can reach them.
                    if !IsExplicitInterfaceImplementation(symbol) && IsMemberOfKeptTopLevelProgram(symbol) {
                        return Visibility.Internal
                    }
                    return Visibility.Private
                }
                case Accessibility.Internal {
                    return Visibility.Internal
                }
                case Accessibility.Protected {
                    // Issue #950: G# now has a first-class `protected` modifier
                    // (CIL family). It is only valid on members of an `open`
                    // class; the translator emits `open` on translatable
                    // non-sealed classes so this maps cleanly.
                    return Visibility.Protected
                }
                case Accessibility.ProtectedOrInternal, Accessibility.ProtectedAndInternal {
                    // `protected internal` (family-or-assembly) and
                    // `private protected` (family-and-assembly) have no single
                    // G# spelling; map to the nearest accessibility 'internal'.
                    context.Report(
                        TranslationDiagnostic(
                            symbol.DeclaredAccessibility.ToString(),
                            "'${symbol.Name}' is '${symbol.DeclaredAccessibility}'; G# has no combined 'protected internal'/'private protected' spelling, mapped to the nearest accessibility 'internal' (ADR-0115 §B.10).",
                            node?.GetLocation(),
                            TranslationSeverity.Warning
                        )
                    )
                    return Visibility.Internal
                }
                default {
                    return Visibility.Default
                }
            }
        }

        /// Whether [`symbol`](paramref) belongs to a retained
        /// top-level-statements `Program`. C# top-level statements execute
        /// inside that type's synthesized entry point and can access private
        /// members throughout its nested type hierarchy. Emitted G# top-level
        /// statements live in a separate compiler-generated type, so those
        /// members must be assembly-visible.
        private func IsMemberOfKeptTopLevelProgram(symbol ISymbol) bool {
            var owner INamedTypeSymbol? = symbol.ContainingType
            while owner?.ContainingType is INamedTypeSymbol containingType {
                owner = containingType
            }
            return SymbolEqualityComparer.Default.Equals(owner, this.keptTopLevelProgram)
        }

        /// Determines whether [`type`](paramref) will be emitted as an
        /// `open class` in G#. Mirrors the class-declaration openness logic in
        /// (cref:VisitAggregate) so member-level `open` is only emitted
        /// when the enclosing class is itself open (otherwise GS0190).
        private func IsTypeEmittedOpen(type INamedTypeSymbol?) bool {
            if type == nil || type.TypeKind != TypeKind.Class || type.IsStatic {
                return false
            }
            if type.IsAbstract || HasProtectedMember(type) {
                return true
            }
            // Issue #4674: a C# class that is not `sealed` is inheritable, and when it
            // is reachable from another assembly that inheritability is API (an
            // analyzer deriving from `SyntaxTree` or `Parser` stops loading if
            // the migrated type is CLR-sealed). `subclassedBases` only sees
            // this project's own subclasses and the other signals only see
            // members, so a public non-sealed class with none of them was
            // emitted sealed.
            return !type.IsSealed &&
                (
                this.efEntityTypes.Contains(type.OriginalDefinition) || this.subclassedBases!!.Contains(
                    type.OriginalDefinition
                ) ||
                    DeclaresOverridableMember(type) ||
                    IsExternallyVisible(type)
            )
        }

        /// Issue #1745: whether a method/property/indexer [`symbol`](paramref)
        /// is emitted with the G# `open` modifier. Extracted from three
        /// byte-identical copies (method, property, and indexer translation) so a
        /// change to the openness rule only needs to be made once.
        /// @param symbol The member symbol, or `null` when translating without semantic info.
        /// @param isOverride Whether the member is emitted with the G# `override` modifier.
        /// @returns `true` when the member should carry `open`.
        private func IsMemberEmittedOpen(symbol ISymbol?, isOverride bool) bool {
            let inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface
            return symbol != nil &&
                !inInterface &&
                !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsPrintedTypeOpen(symbol.ContainingType)
        }

        /// Issues #5252/#5253: whether the type a member is printed into is `open`,
        /// the only openness a member's own `open` may depend on (GS0421: `open`
        /// on a member of a class that is not open). For a type the gsgen stub
        /// rendered abstract only semantically, the printed generated part states
        /// neither `abstract` nor `open` (see (cref:TryGetSemanticOnlyAbstractType)), so
        /// the type is open exactly when the user declared it `open`; every other
        /// type answers (cref:IsTypeEmittedOpen).
        private func IsPrintedTypeOpen(type INamedTypeSymbol?) bool {
            if this.TryGetSemanticOnlyAbstractType(type, out var declaredOpen) {
                return declaredOpen
            }
            return this.IsTypeEmittedOpen(type)
        }

        /// Issues #5252/#5253: whether [`type`](paramref) is one the gsgen stub rendered
        /// `abstract` only because it inherits unimplemented abstract members.
        /// @param type The type, or `null`.
        /// @param declaredOpen Whether the user declared the type `open`.
        /// @returns `true` for such a type.
        private func TryGetSemanticOnlyAbstractType(type INamedTypeSymbol?, out declaredOpen bool) bool {
            declaredOpen = false
            if type == nil || this.semanticOnlyAbstractTypes == nil || this.semanticOnlyAbstractTypes.Count == 0 {
                return false
            }
            return this.semanticOnlyAbstractTypes.TryGetValue(SemanticAbstractTypeKey.Of(type), out declaredOpen)
        }

        /// Collects the inline initializers of get-only/get+init auto-properties
        /// (`public List<T> Items { get; } = new();`,
        /// `public string Text { get; init; } = "empty";`). G# has no property
        /// member initializer, so the initialization is moved into the type's
        /// `init(...)` constructor body (OD-T1). Only meaningful for a plain
        /// class/struct that keeps an explicit constructor (not a lifted primary
        /// constructor, not a record).
        private func CollectGetOnlyAutoPropertyInitializers(members IReadOnlyList[MemberDeclarationSyntax]) List[
            (Name string?, Value GExpression?)
        ] {
            let result = List[(Name string?, Value GExpression?)]()
            for prop in members.OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]() {
                if prop.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) ||
                    prop.Initializer == nil ||
                    !IsGetOnlyAutoProperty(prop) {
                    continue
                }
                // Issue #1910: a merged-in property from another partial part
                // lives in a different `SyntaxTree`.
                using let modelScope = this.context.UseSemanticModelFor(prop.SyntaxTree)
                let symbol IPropertySymbol? = this.context.GetDeclaredSymbol(prop) as IPropertySymbol
                if symbol != nil && (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface) {
                    continue
                }
                // A virtual/override get-only auto-property lowers to a backing
                // field + computed arrow (see TranslateProperty); its
                // initializer seeds the field, not a constructor assignment.
                if symbol != nil && this.IsBackingFieldLoweredGetOnlyAutoProperty(symbol) {
                    continue
                }
                // Issue #3635: the lifted constructor assignment targets the
                // property's declared non-null `T`, but an initializer reading a
                // member of a nullability-OBLIVIOUS assembly is imported by gsc
                // as `T?` (#1354) — bridge with `!!` like the field-initializer
                // paths do.
                result.Add(
                    (
                        this.EmittedName(symbol, prop.Identifier.ValueText),
                        this.ForgiveNullableReferenceValue(
                            prop.Initializer!!.Value,
                            this.TranslateNullSeamExpression(prop.Initializer!!.Value),
                            symbol?.Type,
                            symbol
                        )
                    )
                )
            }
            return result
        }

        /// Determines whether a type declares a designated instance constructor —
        /// one that is non-static and does not delegate to another constructor of
        /// the same type via `: this(...)`. Such a constructor is the place
        /// into which get-only auto-property initializers are injected (OD-T1).
        ///
        /// Issue #3770: whether a C# 12 primary constructor's parameters are read
        /// ONLY by get-only auto-property initializers, so they can move from the
        /// G# class header onto the synthesized designated `init(...)` that
        /// carries those initializers.
        /// @remarks A capture anywhere else — a method or accessor body, a field or
        /// non-get-only property initializer, or a `: Base(param)` forward —
        /// needs the parameter to remain a primary-constructor parameter field, so
        /// the move is unsafe. Partial types are refused outright: another part
        /// this method cannot see may capture the parameter.
        private func CanMovePrimaryParametersToSynthesizedInit(node TypeDeclarationSyntax) bool {
            if node.ParameterList == nil || node.Modifiers.Any(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.PartialKeyword
            ) {
                return false
            }
            // `class C(int a) : Base(a)` forwards a parameter to the base
            // constructor from the header itself, which only a primary
            // constructor can express.
            if node.BaseList?.Types.Any((t BaseTypeSyntax) -> t is PrimaryConstructorBaseTypeSyntax) == true {
                return false
            }
            let parameters = HashSet[ISymbol](SymbolEqualityComparer.Default)
            for parameter in node.ParameterList!!.Parameters {
                if this.context.GetDeclaredSymbol(parameter) is not IParameterSymbol symbol {
                    return false
                }
                parameters.Add(symbol)
            }
            for member in node.Members {
                // The get-only auto-property initializers are exactly what moves
                // into the `init(...)` body, so reads there are fine.
                if member is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .PropertyDeclarationSyntax property &&
                    property.Initializer != nil &&
                    !property
                    .Modifiers
                    .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) && IsGetOnlyAutoProperty(property) {
                    continue
                }
                for identifier in member.DescendantNodesAndSelf().OfType[IdentifierNameSyntax]() {
                    if this.context.GetSymbolInfo(identifier).Symbol is {} referenced && parameters.Contains(
                        referenced
                    ) {
                        return false
                    }
                }
            }
            return true
        }

        // `spellingNode`, when given, overrides where the default is spelled:
        // an ADR-0192 implementing part emits the DEFINITION's default value
        // but must map it at its own parameter, in its own file's scope.
        private func MapConstantDefault(
            symbol IParameterSymbol,
            fallbackNode Microsoft.CodeAnalysis.SyntaxNode?,
            spellingNode Microsoft.CodeAnalysis.SyntaxNode? = nil
        ) GExpression? -> this
            .MapConstantValue(
            symbol.ExplicitDefaultValue,
            symbol.Type,
            spellingNode ?? symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() ?? fallbackNode,
            "parameter '${symbol.Name}''s default value"
        )

        /// Maps a compile-time constant [`value`](paramref) of type
        /// [`type`](paramref) to its G# literal expression. Shared between an
        /// optional parameter's own default ((cref:MapConstantDefault)) and
        /// a call site's `ArgumentKind.DefaultValue` argument (issue #1901:
        /// (cref:TranslateCallArguments) materializes a skipped default
        /// argument explicitly when the callee is invoked indirectly through a
        /// function-typed value — gsc's structural function type, unlike a named
        /// function/method symbol, carries no default to fill in on its own).
        private func MapConstantValue(
            value object?,
            type ITypeSymbol?,
            fallbackNode Microsoft.CodeAnalysis.SyntaxNode?,
            diagnosticSubject string
        ) GExpression? {
            // Issue #1733: an enum-typed default (`Color c = Color.Blue`) must
            // resolve to the member reference, not the boxed underlying integer —
            // see the remarks on <see cref="MapEnumConstant"/>.
            if value != nil && type?.TypeKind == TypeKind.Enum && IsIntegral(value) {
                return this.MapEnumConstant(type, value, fallbackNode, diagnosticSubject)
            }
            switch value {
                case nil {
                    return nil
                }
                case b is bool {
                    return IdentifierExpression(
                        if b {
                            "true"
                        } else {
                            "false"
                        }
                    )
                }
                case s is string {
                    return LiteralExpression.String(s)
                }
                case c is char {
                    return LiteralExpression.Char(c.ToString())
                }
                case d is float64 {
                    return MapSpecialFloatConstant(d, isDouble: true) ?? LiteralExpression.Float(
                        d.ToString(CultureInfo.InvariantCulture)
                    )
                }
                case f is float32 {
                    return MapSpecialFloatConstant(f, isDouble: false) ?? LiteralExpression.Float(
                        f.ToString(CultureInfo.InvariantCulture)
                    )
                }
                case m is decimal {
                    return LiteralExpression.Float(m.ToString(CultureInfo.InvariantCulture))
                }
                default {
                    return if IsIntegral(value) {
                        LiteralExpression.Int(Convert.ToString(value, CultureInfo.InvariantCulture))
                    } else {
                        default(LiteralExpression?)
                    }
                }
            }
        }

        /// Issue #1733: resolves an enum-typed constant's boxed underlying integral
        /// value to the qualified enum-member reference(s) it represents
        /// (`EnumType.Member`), rather than the raw integer. This callsite has
        /// no G# enum-literal syntax available (it feeds a parameter default value /
        /// attribute argument position, not an enum-declaration case), so the
        /// runtime-correct spelling is always the qualified member reference — this
        /// is unrelated to whether (cref:VisitEnumDeclaration) preserves
        /// explicit case values (issue #1912, fixed) since a BCL enum (e.g.
        /// `System.IO.FileAttributes`) has no G# declaration to renumber in
        /// the first place.
        /// A `[Flags]` combination (`A | B`) with no single matching member is
        /// decomposed into the OR of the matching member names; a value that
        /// matches no member (and no flag combination) has no safe G# spelling and
        /// is reported as unsupported rather than emitting a raw int that
        /// renumbering would silently corrupt.
        /// @param enumType The parameter/attribute-argument's enum type.
        /// @param rawValue The boxed underlying integral constant value.
        /// @param node The C# node to anchor an unsupported diagnostic to, or `null` to suppress the
        /// diagnostic.
        /// @param constructDescription A human-readable description of the constant's origin, for the
        /// diagnostic message.
        /// @returns The member reference (or OR'd flag combination) expression, or `null` when no
        /// member/combination matches.
        private func MapEnumConstant(
            enumType ITypeSymbol?,
            rawValue object?,
            node Microsoft.CodeAnalysis.SyntaxNode?,
            constructDescription string
        ) GExpression? {
            if enumType is not INamedTypeSymbol namedEnum || namedEnum.TypeKind != TypeKind.Enum {
                return nil
            }
            let enumTypeName string? = if this.typeMapper.Map(
                namedEnum,
                this.context,
                node?.GetLocation()
            ) is NamedTypeReference typeRef {
                typeRef.Name
            } else {
                this.EmittedName(namedEnum, namedEnum.Name)
            }
            // Issue #1733 N2: comparing/decomposing the constant as `long` throws
            // `OverflowException` (crashing the translator on otherwise-valid input)
            // for a `ulong`-backed enum member whose value exceeds `long.MaxValue`
            // (e.g. `[Flags] enum X : ulong { Big = 0x8000000000000000 }`).
            // Every C# enum underlying type's bit pattern fits in 64 bits, so
            // reinterpreting the raw bits as `ulong` (via <see cref="ToEnumBitPattern"/>)
            // makes equality and the [Flags] bitwise math below overflow-free for
            // every underlying type (byte/sbyte/short/ushort/int/uint/long/ulong)
            // without needing to special-case each one beyond picking the
            // reinterpretation rule.
            let underlyingType = namedEnum.EnumUnderlyingType?.SpecialType ?? SpecialType.System_Int32
            let target = ToEnumBitPattern(rawValue, underlyingType)
            let members = namedEnum
                .GetMembers()
                .OfType[IFieldSymbol]()
                .Where((m IFieldSymbol) -> m.HasConstantValue)
                .ToList()
            for member in members {
                if ToEnumBitPattern(member.ConstantValue, underlyingType) == target {
                    return MemberAccessExpression(
                        IdentifierExpression(enumTypeName),
                        this.EmittedName(member, member.Name)
                    )
                }
            }
            let isFlags = namedEnum.GetAttributes().Any(
                (a AttributeData) -> a.AttributeClass?.ToDisplayString(
                    SymbolDisplayFormat.FullyQualifiedFormat
                ) == "global::System.FlagsAttribute"
            )
            if isFlags && target != uint64(0) {
                var remaining = target
                var combined GExpression? = nil
                for member in members.OrderByDescending(
                    (m IFieldSymbol) -> ToEnumBitPattern(m.ConstantValue, underlyingType)
                ) {
                    let memberValue = ToEnumBitPattern(member.ConstantValue, underlyingType)
                    if memberValue == uint64(0) || (remaining & memberValue) != memberValue {
                        continue
                    }
                    let memberExpr GExpression = MemberAccessExpression(
                        IdentifierExpression(enumTypeName),
                        this.EmittedName(member, member.Name)
                    )
                    combined = if combined == nil {
                        memberExpr
                    } else {
                        cast[GExpression](BinaryExpression(combined, "|", memberExpr))
                    }
                    remaining &= ~memberValue
                }
                if remaining == uint64(0) && combined != nil {
                    return combined
                }
            }
            if node != nil {
                this.context.ReportUnsupported(
                    node,
                    "$constructDescription is the enum value '${Convert.ToString(rawValue, CultureInfo.InvariantCulture)}' of '${namedEnum.Name}', which matches no member or [Flags] combination; G# renumbers enum members by declaration order so the raw underlying integer cannot be emitted safely."
                )
            }
            return nil
        }

        private func VisitAggregate(node TypeDeclarationSyntax) GMember? {
            let kind = MapAggregateKind(node)
            if kind == nil {
                this.context.ReportUnsupported(node, "unsupported aggregate kind '${node.Kind()}'.")
                return nil
            }
            let symbol INamedTypeSymbol? = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol
            if !this.emitGeneratedImplementingParts && GeneratedSourceDetection.IsGeneratedSource(
                node.SyntaxTree,
                this.projectDirectory
            ) &&
                CSharpToGSharpTranslator
                .IsRegexGeneratorDeclaration(symbol) {
                let (retained, regenerated) = this.GetRegexGeneratorImplementationState(node.SyntaxTree)
                if !retained {
                    return nil
                }
                if regenerated && this.reportedMixedRegexGeneratorTrees.Add(node.SyntaxTree) {
                    const message = "this RegexGenerator document contains implementations whose [GeneratedRegex] " +
                        "definitions are only partly included in this translation; translate all or none of " +
                        "those definition files so generated helper types are not duplicated."
                    this.context.ReportUnsupported(node, message)
                }
            }
            // Issue #1910: a `partial` type is declared once per file/part but
            // has a single symbol. Only the "primary" part (parts[0], see
            // `CSharpToGSharpTranslator.CollectPartialTypeParts`) emits a G#
            // type declaration; its member loop below merges in every other
            // part's members so the type is declared exactly once (GS0102 was
            // the two-full-declarations symptom). A non-primary part therefore
            // contributes nothing of its own here.
            // ADR-0145 preserve mode bypasses partial merging entirely: `otherParts`
            // stays null, so no non-primary part is skipped and no other part's
            // members are pulled in below — every `partial` declaration is emitted
            // standalone (using only its own `node.Members`).
            var otherParts List[TypeDeclarationSyntax]? = nil
            if !this.preservePartialParts && symbol != nil && this.partialTypeParts.TryGetValue(symbol, out var parts) {
                let isPrimaryPart = parts[0].SyntaxTree == node.SyntaxTree && parts[0].Span == node.Span
                if !isPrimaryPart {
                    return nil
                }
                otherParts = parts.Skip(1).ToList()
            }
            // Synthetic instance helpers are scoped to their owning aggregate;
            // nested type translation must not leak them outward.
            let outerInstanceSynthHelpers List[MethodDeclaration]? = this.state.PendingInstanceSynthHelpers
            let outerStaticSynthHelpers List[MethodDeclaration]? = this.state.PendingStaticSynthHelpers
            let outerEmittedAggregate INamedTypeSymbol? = this.state.CurrentEmittedAggregate
            this.state.PendingInstanceSynthHelpers = List[MethodDeclaration]()
            this.state.PendingStaticSynthHelpers = List[MethodDeclaration]()
            this.state.CurrentEmittedAggregate = symbol
            try {
                return this.VisitAggregateCore(node, kind, symbol, otherParts)
            } finally {
                this.state.PendingInstanceSynthHelpers = outerInstanceSynthHelpers
                this.state.PendingStaticSynthHelpers = outerStaticSynthHelpers
                this.state.CurrentEmittedAggregate = outerEmittedAggregate
            }
        }

        private func VisitAggregateCore(
            node TypeDeclarationSyntax,
            kindValue TypeDeclarationKind,
            symbol INamedTypeSymbol?,
            otherParts IReadOnlyList[TypeDeclarationSyntax]?
        ) GMember? {
            let kind TypeDeclarationKind? = kindValue
            // Issue #2228: set below when a record's body auto-property data is
            // successfully lifted to synthetic primary-constructor parameters;
            // reused after the downgrade decision as the type's `ConstructorLift`
            // so the member loop skips the now-lifted properties.
            var autoPropertyLift = ConstructorLift.None
            // Preserve init-only/required record properties as properties. Mutable
            // body auto-properties may still use the existing primary-field lift,
            // but data types now admit auto-properties and zero fields, so an
            // unlifted property no longer forces a lossy plain-class downgrade.
            if (kind == TypeDeclarationKind.DataClass || kind == TypeDeclarationKind.DataStruct) &&
                node is RecordDeclarationSyntax record {
                let hasAutoPropData = RecordHasAutoPropertyDataMember(record)
                let hasExplicitInstanceCtor = record
                    .Members
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
                    .Any(
                    (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    )
                )
                // Issue #2228: a record whose data lives entirely in body
                // `init`/get-only auto-properties — no positional primary-ctor
                // parameters, no explicit instance constructor — still has a
                // canonical `data class`/`data struct` form: lift each such
                // auto-property into a synthetic primary-constructor parameter
                // (+ field), exactly like AnalyzeConstructorLift already does for
                // an explicit parameter-copy constructor. This keeps value
                // equality / `with` support instead of downgrading to a plain
                // class/struct (which a `with` expression then cannot target).
                if hasAutoPropData && !hasExplicitInstanceCtor && GetPrimaryConstructorParameterList(symbol) == nil {
                    autoPropertyLift = this.AnalyzeAutoPropertyLift(record, symbol, kind!!)
                }
            }
            let isStaticClass = symbol != nil && symbol.IsStatic && kind == TypeDeclarationKind.Class
            // Issue #1910: merge in every other partial part's members (from any
            // file) so the constructor-lift/static-initializer/property-inits
            // passes below and the main member loop see the FULL member set,
            // not just this (primary) part's own `node.Members`.
            let mergedMembers = node.Members.ToList()
            if otherParts != nil {
                for part in otherParts {
                    mergedMembers.AddRange(part.Members)
                }
            }
            // T2 (ADR-0115 §B.3): canonicalize immutable-field initialization.
            // A `let` field is read-only after construction but — like a C#
            // `readonly` field (issue #947) — is assignable inside the declaring
            // type's `init(...)` constructor. The lift below still prefers the
            // idiomatic primary-constructor / field-initializer form when the
            // constructor is a simple parameter-to-member copy; non-liftable
            // constructors keep their explicit `init` and assign the `let`
            // fields directly, which is now valid G#.
            let lift = if autoPropertyLift != ConstructorLift.None {
                autoPropertyLift
            } else {
                this.AnalyzeConstructorLift(node, mergedMembers, symbol, kind!!)
            }
            // Issues #1990/#2435: G# data structs have no explicit `init`
            // member, but a C# record-struct constructor whose complete effect is a
            // once-only set of member assignments can still be represented at
            // every call site as a struct literal. Keep the struct and omit those
            // constructor declarations; BuildObjectCreationCore resolves the
            // actual overload and replays its analyzed plan. If even one
            // constructor has logic the literal cannot preserve, diagnose the
            // whole unsupported shape explicitly rather than silently dropping
            // the type or changing value semantics via a class downgrade.
            var callSiteLoweredStructConstructors HashSet[
                Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax
            ]? = nil
            if !lift.DropConstructor &&
                kind == TypeDeclarationKind.DataStruct &&
                mergedMembers
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]().Any(
                (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                )
            ) {
                callSiteLoweredStructConstructors = HashSet[
                    Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax
                ]()
                var unsupportedConstructorReason string? = nil
                for ctor in mergedMembers.OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
                    .Where(
                    (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    )
                ) {
                    using let modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree)
                    let ctorSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(ctor) as IMethodSymbol
                    if !this.TryAnalyzeStructConstructor(ctorSymbol, symbol, out _, out unsupportedConstructorReason) {
                        break
                    }
                    callSiteLoweredStructConstructors.Add(ctor)
                }
                let instanceConstructorCount = mergedMembers
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]().Count(
                    (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    )
                )
                if callSiteLoweredStructConstructors.Count != instanceConstructorCount {
                    this.context.ReportUnsupported(
                        node,
                        "'${node.Identifier.Text}' has no canonical G# form: it is a record struct with an instance constructor that cannot be lowered to call-site struct literals. $unsupportedConstructorReason A G# data struct admits no explicit 'init(...)' constructor by design (ADR-0115 §B.5, §B.14; issues #1990 and #2435). Silently mapping it to a class would change value semantics to reference semantics (Equals/GetHashCode become reference-identity, default(T) becomes null, copies become aliases, storage becomes heap-allocated), so it is not auto-translated."
                    )
                    return nil
                }
                this.context.Report(
                    TranslationDiagnostic(
                        "ConstructorDeclaration",
                        "record struct '${node.Identifier.Text}' constructor overloads are lowered at their call sites to G# struct literals because G# data structs have no explicit 'init(...)' members (issue #2435).",
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            // Issue #2003: a primary-constructor parameter (native C#12 shape or
            // T2-lifted from an explicit ctor) becomes a same-named G# field
            // (ADR-0065 §5) that is a cs2gs-SYNTHESIZED sibling — it has no
            // corresponding Roslyn source symbol for a captured-but-never-assigned
            // parameter, so `symbol.ContainingType.GetMembers()` (used by the
            // `field`-keyword backing-field collision check below) cannot see it.
            // Computed here — before the member loop that translates properties —
            // so it can be threaded into that collision check as an extra reserved
            // name set.
            var primaryCtor IReadOnlyList[Parameter]? = if lift.DropConstructor {
                lift.PrimaryParameters
            } else {
                this.MapPrimaryConstructor(node)
            }
            let primaryCtorParamNames = HashSet[string](
                primaryCtor?.Select((p Parameter) -> p.Name) ?? Enumerable.Empty[string](),
                StringComparer.Ordinal
            )
            // Issue #4350 (review): allocate every lowered get-only
            // auto-property's backing field NOW, with the primary-constructor
            // names reserved, so a constructor write translated before its
            // property (`this.Value = v` or `Value = v`) reuses a name that
            // cannot collide with a synthesized primary-constructor field.
            for loweredCandidate in mergedMembers
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]() {
                using let loweredModelScope = this.context.UseSemanticModelFor(loweredCandidate.SyntaxTree)
                if this.context.GetDeclaredSymbol(loweredCandidate) is IPropertySymbol loweredSymbol &&
                    this
                    .IsBackingFieldLoweredGetOnlyAutoProperty(loweredSymbol) {
                    this.RegisterSynthesizedPropertyBackingField(loweredSymbol, primaryCtorParamNames)
                }
            }
            // OD-T1: when the explicit constructor is kept (not lifted to a primary
            // constructor) and the type is a plain class/struct, get-only
            // auto-property inline initializers (`{ get; } = new();`) must move into
            // the constructor body — G# has no property member initializer.
            let propertyCtorInits = if !lift.DropConstructor &&
                (kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.Struct) {
                this.CollectGetOnlyAutoPropertyInitializers(mergedMembers)
            } else {
                List[(Name string?, Value GExpression?)]()
            }
            // Issue #1729 (mode 4): staticFieldInitializers is one shared dictionary
            // reused across the whole recursive VisitAggregate walk. Snapshot the
            // keys already present (belonging to an enclosing type still being
            // processed) so that when this invocation's own entries are cleared
            // below — including after recursing into a nested type declaration,
            // which runs this same method again — only the entries this
            // invocation itself added are removed. Without this, a nested type's
            // exit would wipe the outer type's not-yet-consumed folded fields.
            let staticFieldInitializersSnapshot = HashSet[ISymbol](
                this.state.StaticFieldInitializers.Keys,
                SymbolEqualityComparer.Default
            )
            this.CollectStaticFieldInitializers(mergedMembers, symbol)
            let membersToTranslate = mergedMembers.Select(
                (member MemberDeclarationSyntax) -> (Member: member, OwnedExtensionTarget: default(INamedTypeSymbol))
            )
                .ToList()
            if symbol != nil && this.ShouldAttachOwnedExtensions(node, symbol) && this.ownedExtensions.TryGetMethods(
                symbol,
                out var ownedExtensionMethods
            ) {
                membersToTranslate.AddRange(
                    ownedExtensionMethods.Where(
                        (method MethodDeclarationSyntax) -> this.CanLowerOwnedExtension(method) &&
                            !this
                            .IsPreservedOwnedExtension(
                            this
                                .context
                                .Compilation
                                .GetSemanticModel(method.SyntaxTree)
                                .GetDeclaredSymbol(method) as IMethodSymbol
                        )
                    )
                        .Select(
                        (method MethodDeclarationSyntax) -> (
                            Member: cast[MemberDeclarationSyntax](method),
                            OwnedExtensionTarget: symbol
                        )
                    )
                )
            }
            let instanceMembers = List[GMember]()
            let sharedMembers = List[GMember]()
            // Issue #4234: set when at least one extension method was lifted
            // out of this static class (see the `isStaticClass` branch
            // below) — the class must survive even empty so the lifted
            // method's `@ExtensionOwner(typeof(T))` annotation still names a
            // real declaration, and gsc can host the MethodDef on it.
            var hostedAnyExtensionOnStaticClass = false
            for (member, ownedExtensionTarget) in membersToTranslate {
                // Issue #1910: a merged-in member from another partial part lives
                // in a different `SyntaxTree`; issue #2821 owned extension methods
                // can as well. Resolve either through that tree's semantic model.
                using let modelScope = this.context.UseSemanticModelFor(member.SyntaxTree)
                var attachedMemberComments = false
                // Issue #4422: a by-reference `x!` outside any statement (an
                // expression-bodied member) collects its GS0612 suppression here.
                let memberSuppressions = HashSet[string](StringComparer.Ordinal)
                this.state.PendingStatementSuppressions = memberSuppressions
                for (translated, isStatic) in this.TranslateMember(
                    member,
                    kind!!,
                    lift,
                    propertyCtorInits,
                    primaryCtorParamNames,
                    callSiteLoweredStructConstructors,
                    ownedExtensionTarget
                ) {
                    // Issue #3469: the member's leading comments ride on the
                    // FIRST G# member it translates to, wherever that member
                    // is placed (instance body, shared block, or top level).
                    if !attachedMemberComments && translated != nil {
                        AttachSourceComments(translated, member)
                        this.SanitizeDocParamComments(translated, member)
                        // Issues #3820/#3824, ADR-0175: a `#pragma warning
                        // disable GSA####` region covering this declaration
                        // becomes an `@SuppressDiagnostic` annotation on it.
                        AttachPragmaSuppressions(translated, member)
                        attachedMemberComments = true
                    }
                    AttachExpressionBodySuppressions(translated, member, memberSuppressions)
                    // Issue #3501: a member translation may DROP its output (a
                    // reported gap, e.g. the second colliding explicit-interface
                    // property in a dual-dictionary fixture). A null must not
                    // reach the member lists — the printer throws on it and the
                    // whole document (and its app) fails translate.
                    if translated == nil {
                        continue
                    }
                    // A C# operator overload translates to a receiver-clause
                    // `func (a T) operator <op>(...)`; like every receiver-clause
                    // func it only binds at top level, so it is lifted out as a
                    // sibling regardless of whether the owning type is a value or
                    // reference aggregate (ADR-0035, sample Operators.gs; §B.5).
                    if translated is MethodDeclaration{Receiver: not nil} opMethod && opMethod.Name.StartsWith(
                        "operator ",
                        StringComparison.Ordinal
                    ) {
                        this.state.PendingTopLevelDeclarations.Add(translated)
                        continue
                    }
                    // A C# extension method (`this T self`) on a `static class`
                    // translates to a receiver-clause `func`; a receiver-clause
                    // func only binds at top level (its receiver is not in scope
                    // inside a `shared { }` block), so it is lifted out
                    // (ADR-0115 §B.5).
                    if isStaticClass && translated is MethodDeclaration{Receiver: not nil} liftedExtension {
                        // Issue #4234: the lift above drops the CLR owner-type
                        // identity a self-hosted build of THIS SAME method would
                        // otherwise need — e.g. native
                        // `Gsharp.Concurrency.ChannelExtensions::Close` becomes
                        // `Gsharp.Concurrency.<Program>::Close` once gsc compiles
                        // the migrated source, breaking reflection tests
                        // (`typeof(ChannelExtensions).GetMethods()`) and analyzer
                        // owner-specific recognition (RendezvousBatchAnalyzer's
                        // `ChannelBatchExtensions` check) that key off the exact
                        // declaring type. `@ExtensionOwner(typeof(T))` tells the
                        // binder to host the MethodDef on the original class's
                        // TypeDef instead of the package's `<Program>`, matching
                        // the native assembly's shape; the static class is kept
                        // below so that type still exists to name.
                        //
                        // Issue #3413 exception: when the owner has a private
                        // nested aggregate, the translator already keeps this
                        // extension's real body as an in-owner shared-block
                        // method of the SAME NAME (so it retains access to the
                        // private nested type) and emits this lifted func as a
                        // thin forwarding wrapper. Tagging the wrapper with
                        // `@ExtensionOwner(typeof(Owner))` would route it onto
                        // the owner too — a second MethodDef with the identical
                        // name and signature as the real one already there,
                        // which is a duplicate, not a fix. That owner already
                        // keeps its identity by construction, so skip tagging.
                        if this.context.GetDeclaredSymbol(member) is IMethodSymbol extensionMethodSymbol &&
                            CSharpToGSharpTranslator
                            .RequiresOwnerScopedExtension(extensionMethodSymbol) {
                            this.state.PendingTopLevelDeclarations.Add(translated)
                            continue
                        }
                        hostedAnyExtensionOnStaticClass = true
                        if liftedExtension.Attributes is List[AttributeUse]extensionAttributes {
                            // Issue #1839-style keyword collisions: reuse the
                            // SAME name-allocation this class's own
                            // TypeDeclaration below is built from (keyed by
                            // `symbol`, so it returns the identical cached
                            // spelling) rather than the raw C# identifier —
                            // `node.Identifier.Text` can carry a C#-only `@`
                            // verbatim marker (`@select`) that means nothing in
                            // G# and isn't the name G#'s own keyword-collision
                            // escaping gives the class (`$select`).
                            let ownerName string? = this.EmittedName(symbol, node.Identifier.ValueText)
                            extensionAttributes.Add(
                                AttributeUse(
                                    "ExtensionOwner",
                                    []AttributeArgument{
                                        AttributeArgument(TypeOfExpression(NamedTypeReference(ownerName)))
                                    }
                                )
                            )
                        }
                        this.state.PendingTopLevelDeclarations.Add(translated)
                        continue
                    }
                    if translated is NamedDelegateDeclaration {
                        this.state.PendingTopLevelDeclarations.Add(translated)
                        continue
                    }
                    // A nested type declaration (`class`/`struct`/`enum`/...) maps
                    // to a directly-nested G# type member; the parser does not allow
                    // a type declaration inside a `shared { }` block, so it is always
                    // placed in the enclosing type body regardless of staticness.
                    if translated is TypeDeclaration || translated is EnumDeclaration {
                        instanceMembers.Add(translated)
                        continue
                    }
                    if isStatic || isStaticClass {
                        sharedMembers.Add(translated)
                    } else {
                        instanceMembers.Add(translated)
                    }
                }
            }
            instanceMembers.AddRange(this.state.PendingInstanceSynthHelpers!!)
            sharedMembers.AddRange(this.state.PendingStaticSynthHelpers!!)
            // OD-T1: if get-only auto-property initializers needed to move into a
            // constructor but the type declares no designated instance constructor,
            // synthesize a parameterless `init()` to carry them (G# has no property
            // member initializer). Reference types only — a class is the case that
            // arises in practice.
            if propertyCtorInits.Count > 0 &&
                kind == TypeDeclarationKind.Class &&
                !HasDesignatedInstanceConstructor(mergedMembers) {
                var initStatements List[GStatement]? = propertyCtorInits.Select(
                    (p(Name string, Value GExpression)) -> cast[GStatement](
                        AssignmentStatement(IdentifierExpression(p.Name), p.Value)
                    )
                )
                    .ToList()
                // Issue #3770: when the type ALSO carries a C# 12 primary
                // constructor, a *parameterless* `init()` is unreachable — every
                // construction goes through the primary constructor, so the
                // initializer assignments never run and every such property is
                // silently left at its default (this compiles and ILVerifies
                // clean, so only a runtime test sees it). The T2 explicit-ctor
                // lift already refuses to emit this conflicting pair; the
                // C# 12 primary-ctor path had no such guard.
                //
                // The faithful shape is a single designated `init(<primary
                // parameters>)` carrying the assignments, with the class header
                // left parameterless — a C# primary constructor whose parameters
                // are only read by member initializers has exactly that meaning.
                // When a parameter is captured anywhere else (a method body, a
                // field initializer, a `: Base(...)` forward), it must stay a
                // primary-constructor parameter field, so the move is skipped and
                // the conflict is reported instead of being emitted silently.
                let initParameters = List[Parameter]()
                if primaryCtor != nil && primaryCtor.Count > 0 {
                    if this.CanMovePrimaryParametersToSynthesizedInit(node) {
                        initParameters.AddRange(primaryCtor)
                        primaryCtor = nil
                    } else {
                        let conflictMessage = "'${node.Identifier.Text}' has a C# 12 primary constructor and get-only auto-property " +
                            "initializer(s), but a primary-constructor parameter is also captured elsewhere in " +
                            "the type, so the initializers cannot be moved into a designated 'init(...)'. The " +
                            "property initializer(s) are dropped."
                        this.context.Report(
                            TranslationDiagnostic(
                                "PropertyDeclaration",
                                conflictMessage,
                                node.Identifier.GetLocation(),
                                TranslationSeverity.Unsupported
                            )
                        )
                        initStatements = nil
                    }
                }
                if initStatements != nil {
                    instanceMembers.Insert(0, ConstructorDeclaration(initParameters, BlockStatement(initStatements)))
                }
            }
            let members = List[GMember](instanceMembers)
            if sharedMembers.Count > 0 {
                if isStaticClass {
                    // ADR-0195 / issue #4674: a C# static class is a G# `shared class`,
                    // whose body IS its shared member list; a `shared { }` block
                    // inside it is an error.
                    members.AddRange(sharedMembers)
                } else {
                    members.Add(SharedBlock(sharedMembers))
                }
            }
            // Issue #1729 (mode 4): remove only the entries this invocation added
            // (see snapshot above), not the whole shared dictionary — an enclosing
            // type may still have not-yet-consumed folded fields pending.
            for key in this.state.StaticFieldInitializers.Keys.ToList() {
                if !staticFieldInitializersSnapshot.Contains(key) {
                    this.state.StaticFieldInitializers.Remove(key)
                }
            }
            // A `static class` whose every member was an extension method lifted to
            // top level has no remaining body; drop the class entirely (ADR-0115 §B.5).
            //
            // Issue #3750: unless something still observes the holder's IDENTITY.
            // The lifted receiver-clause funcs carry the holder's BEHAVIOUR but not
            // its name, so a surviving `typeof(Holder)` would name a type that no
            // longer exists (GS0113) — and, where the result feeds a member lookup,
            // cascade into GS0159. Keeping the (now empty) declaration is what makes
            // the reference resolve, and it is the honest translation: the C# source
            // declared a type, and the migrated code still names it. `typeof` is the
            // only reference form that can survive here — `nameof(Holder)` folds to a
            // string literal, and `Holder.M(recv, args)` / bare `M(recv, args)` are
            // rewritten to the receiver form (see `TranslateInvocation`) — so a
            // holder nothing `typeof`s is still elided and the common case keeps the
            // idiomatic extension-only output.
            //
            // Issue #4234: also keep it when a lifted extension carries an
            // `@ExtensionOwner(typeof(Holder))` back-reference — that
            // annotation needs a real declaration to resolve, and the whole
            // point of keeping it is to give the self-hosted MethodDef this
            // class's CLR identity back (matching the native assembly's
            // metadata shape), not the package's `<Program>`.
            //
            // Issue #4674 (ADR-0195): only an extension HOLDER is elided, that is a class whose
            // every member was an extension method. A static class the author wrote empty
            // (`public static class Marker { }`), or one that holds only things that also
            // leave the body (a nested delegate is lifted to a top-level declaration), is a
            // declared type of the assembly's API and now has a direct form, a
            // `shared class`, so it is kept.
            if isStaticClass && members.Count == 0 && mergedMembers.Count > 0 && mergedMembers.All(
                IsExtensionMethodDeclaration
            ) &&
                !hostedAnyExtensionOnStaticClass &&
                !CSharpToGSharpTranslator.IsTypeOfReferenced(this.context.Compilation, symbol, this.retainedFilePaths) {
                return nil
            }
            if isStaticClass {
                this.context.Report(
                    TranslationDiagnostic(
                        "ClassDeclaration",
                        "C# 'static class ${node.Identifier.Text}' is mapped to a G# 'shared class' whose members sit directly in its body, with no 'shared { }' block (ADR-0195 / ADR-0115 §B.11).",
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            let (baseType, interfaces) = this.MapBaseClause(symbol, node, kind!!)
            let baseConstructorArguments List[GExpression]? = this.MapPrimaryConstructorBaseArguments(node, baseType)
            let typeParameters = this.MapTypeParameters(symbol)
            // A class with `protected` members must be an `open class` in G#
            // (GS0380) — `protected` is meaningless on a non-inheritable type —
            // except that a `protected override` (whose accessibility the base
            // dictates) is valid on a sealed, non-`open` class, so a C# `sealed`
            // class keeps its sealedness (issue #4674; see HasProtectedMember).
            // A C# `record` (G# `data class`) is reference-typed and may be
            // subclassed (e.g. `record Derived : Base`); like a plain class it must
            // be declared `open` in G# to permit subclassing (GS0181) or to carry a
            // `protected` member (GS0380). `data struct`/`struct`/`interface` are
            // excluded (value types are not subclassable; interfaces are open by
            // nature).
            let isOpenableKind = kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.DataClass
            // Issue #4674: the openness decision lives in IsTypeEmittedOpen alone, so a
            // member's `open` (IsMemberEmittedOpen) can never disagree with its
            // declaring type's.
            let isOpen = symbol != nil && isOpenableKind && this.IsTypeEmittedOpen(symbol)
            // ADR-0195 / issue #4674: a C# `abstract class`/`abstract record` maps to
            // G#'s `abstract class`/`abstract data class`, which is inheritable
            // (the modifier implies `open`) and uninstantiable even when the
            // type declares no abstract member (gsc used to infer abstractness
            // from abstract members alone, so `BoundTreeWalker` became concrete).
            var isAbstract = symbol != nil && symbol.IsAbstract && isOpenableKind
            // A gsgen stub can be temporarily abstract while instance partial
            // methods await generation. Do not declare that status on a generated
            // part unless the generator itself stated the modifier.
            if this.emitGeneratedImplementingParts && !node.Modifiers.Any(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.AbstractKeyword
            ) {
                isAbstract = false
            }
            // Issues #5252/#5253: a generated part of a type that is abstract only
            // semantically states neither `abstract` (a generator mirrors the stub's
            // modifiers, and gsc unions `abstract` across parts, which would make
            // the user's class uninstantiable, GS0386) nor `open` (the user's part
            // states it; a member's `open` follows it, IsPrintedTypeOpen). Even a
            // generator-authored `abstract` is dropped: the declared shape is the
            // user's alone.
            var isPartOpen = isOpen
            if this.TryGetSemanticOnlyAbstractType(symbol, out var unusedDeclaredOpen) {
                isAbstract = false
                isPartOpen = false
            }
            // Issue #1910 (gap 1 & 2): a `partial` type's attributes/`unsafe`
            // modifier can legally sit on ANY part, not just the primary one
            // (Roslyn's `symbol.GetAttributes()` already merges them). Union in
            // every other part's `AttributeLists`/`Modifiers` so nothing
            // declared on a non-primary part is silently dropped.
            let mergedAttributeLists = if otherParts == nil {
                node.AttributeLists
            } else {
                node.AttributeLists.Concat(
                    otherParts.SelectMany(
                        func (p TypeDeclarationSyntax) IEnumerable[AttributeListSyntax] {
                            return p.AttributeLists
                        }
                    )
                )
            }
            let isUnsafe = node.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnsafeKeyword) ||
                (
                otherParts != nil && otherParts.Any(
                    (p TypeDeclarationSyntax) -> p.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.UnsafeKeyword)
                )
            )
            // ADR-0145 (§C/§D) / issue #3410: default preserve mode carries the
            // C# `partial` modifier onto each standalone G# part. Legacy merge
            // mode drops it from the single merged type (issue #1910), unless
            // `markMergedTypePartial` keeps it so gsc's own gsgen-produced part
            // can merge into that result (issue #2215).
            let sourceWasPartial = node.Modifiers.Any(
                (m Microsoft.CodeAnalysis.SyntaxToken) -> m.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.PartialKeyword
                )
            ) ||
                (
                otherParts != nil && otherParts.Any(
                    (p TypeDeclarationSyntax) -> p.Modifiers.Any(
                        (m Microsoft.CodeAnalysis.SyntaxToken) -> m.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.PartialKeyword
                        )
                    )
                )
            )
            let isPartial = sourceWasPartial && (this.preservePartialParts || this.markMergedTypePartial)
            // ADR-0058 / issue #367 (issue #3869): a C# `ref struct` is by-ref-like.
            // Dropping the modifier does not merely lose a hint — it changes the
            // emitted type's CLR identity: without `IsByRefLikeAttribute` the type
            // is an ordinary struct, and one holding a `Span<T>` instance field
            // then fails to type-load (`TypeLoadException` out of
            // `GetExportedTypes()`), which silently emptied a whole migrated test
            // assembly. `symbol.IsRefLikeType` is the semantic truth; the syntactic
            // `ref` modifier (on this part or any other part of a partial type) is
            // the fallback when the type did not bind.
            let isRefLike = symbol?.IsRefLikeType == true || node.Modifiers.Any(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.RefKeyword
            ) ||
                (
                otherParts != nil && otherParts.Any(
                    (p TypeDeclarationSyntax) -> p.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.RefKeyword)
                )
            )
            let attributes = this.MapAttributes(mergedAttributeLists)
            return TypeDeclaration(
                kind!!,
                this.EmittedName(symbol, node.Identifier.ValueText),
                typeParameters: typeParameters,
                primaryConstructorParameters: primaryCtor,
                baseType: baseType,
                baseConstructorArguments: baseConstructorArguments,
                interfaces: interfaces,
                members: members,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isPartOpen && !isAbstract,
                isAbstract: isAbstract,
                attributes: attributes,
                isUnsafe: isUnsafe,
                isPartial: isPartial,
                isRefLike: isRefLike,
                isShared: isStaticClass
            )
        }

        private func ShouldAttachOwnedExtensions(node TypeDeclarationSyntax, symbol INamedTypeSymbol?) bool {
            if !this.preservePartialParts || !this.partialTypeParts.TryGetValue(symbol!!, out var parts) {
                return true
            }
            return parts[0].SyntaxTree == node.SyntaxTree && parts[0].Span == node.Span
        }

        /// Analyzes a type's single instance constructor to decide the canonical
        /// G# immutable-field initialization form (ADR-0115 §B.3 / T2). A field
        /// assigned directly from a constructor parameter is lifted to a primary
        /// constructor parameter; a field assigned an expression independent of the
        /// constructor parameters becomes a field initializer; when every
        /// statement and parameter is consumed this way the explicit
        /// `init` constructor is dropped. Anything that does not fit the
        /// pattern leaves the constructor untouched ((cref:ConstructorLift.None)).
        ///
        /// Issue #2228: lifts a record's body `init`/get-only auto-property data
        /// members into synthetic primary-constructor parameters (+ fields), the
        /// same target shape (cref:AnalyzeConstructorLift) produces for an
        /// explicit parameter-copy constructor. Applies only when the record has
        /// no positional primary-constructor parameters and no explicit instance
        /// constructor to conflict with (checked by the caller) — every eligible
        /// auto-property becomes one primary-constructor parameter, in
        /// declaration order, with the property's inline initializer carried
        /// over as the parameter's default value. A property without an
        /// initializer receives `default(T)`, matching the value assigned
        /// by C#'s synthesized parameterless record constructor. Bails (returns
        /// (cref:ConstructorLift.None)) if any auto-property participates
        /// in an interface/override contract (OD-T1): a G# primary-constructor
        /// parameter is not a property, so lifting it would break the contract
        /// (GS0187) — the caller then falls back to the plain class/struct
        /// downgrade.
        private func AnalyzeAutoPropertyLift(
            record RecordDeclarationSyntax,
            symbol INamedTypeSymbol?,
            kind TypeDeclarationKind
        ) ConstructorLift {
            if symbol == nil {
                return ConstructorLift.None
            }
            let eligible = record
                .Members
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]()
                .Where(
                (p Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax) -> !p.Modifiers.Any(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                ) &&
                    p.ExpressionBody == nil &&
                    p.AccessorList != nil &&
                    p.AccessorList!!
                    .Accessors
                    .All((a AccessorDeclarationSyntax) -> a.Body == nil && a.ExpressionBody == nil) &&
                    p.AccessorList!!
                    .Accessors
                    .Any(
                    (a AccessorDeclarationSyntax) -> a.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                    )
                )
            )
                .ToList()
            if eligible.Count == 0 {
                return ConstructorLift.None
            }
            let primaryParameters = List[Parameter]()
            let propertiesAsParams = HashSet[IPropertySymbol](SymbolEqualityComparer.Default)
            let propertiesAsBodyFields = HashSet[IPropertySymbol](SymbolEqualityComparer.Default)
            let bodyFieldInitializers = Dictionary[IPropertySymbol, GExpression](SymbolEqualityComparer.Default)
            for prop in eligible {
                if this.context.GetDeclaredSymbol(prop) is not IPropertySymbol propSymbol ||
                    IsContractProperty(propSymbol) {
                    return ConstructorLift.None
                }
                if propSymbol.SetMethod == nil {
                    continue
                }
                if propSymbol.IsRequired || propSymbol.SetMethod?.IsInitOnly == true {
                    continue
                }
                let type GTypeReference? = this.typeMapper.Map(
                    propSymbol.Type,
                    this.context,
                    prop.Identifier.GetLocation()
                )
                // Issue #2281: a G# optional-parameter default must be a
                // compile-time constant (GS0265) — but a C# record property
                // initializer is NOT required to be one (it is evaluated once
                // per constructed instance, exactly like a field initializer).
                // Use the semantic model (not a syntactic guess, per the
                // "never guess" rule) to tell the two shapes apart.
                if prop.Initializer != nil &&
                    !this
                    .context
                    .SemanticModel
                    .GetConstantValue(prop.Initializer!!.Value)
                    .HasValue {
                    // A `data struct` has no always-available parameterless
                    // constructor distinct from its primary constructor (a
                    // value type's zero-arg construction goes through the
                    // struct-literal path, which only special-cases OMITTED
                    // fields, not omitted PRIMARY-CTOR PARAMETERS) — so there
                    // is no sound place to run a non-constant initializer for
                    // a data struct. Bail the whole lift so the caller's
                    // existing downgrade-to-plain-struct path takes over,
                    // which already moves such an initializer into a
                    // synthesized instance constructor body (OD-T1).
                    if kind == TypeDeclarationKind.DataStruct {
                        return ConstructorLift.None
                    }
                    // A `data class` always emits BOTH a parameterless
                    // constructor and its primary constructor (issue #2263):
                    // the parameterless one runs every declared instance field
                    // initializer before returning, exactly like a C# record's
                    // per-instance property initializer. Lifting this property
                    // to a plain body `let` field (instead of a primary-ctor
                    // parameter) reuses that machinery — the required/optional
                    // machinery on the primary constructor itself never needs
                    // to represent a non-constant value at all.
                    propertiesAsBodyFields.Add(propSymbol)
                    bodyFieldInitializers[propSymbol] = this.TranslateExpression(prop.Initializer!!.Value)!!
                    continue
                }
                let defaultValue GExpression? = if prop.Initializer != nil {
                    this.TranslateExpression(prop.Initializer!!.Value)
                } else {
                    cast[GExpression](DefaultValueExpression(type))
                }
                primaryParameters.Add(
                    Parameter(
                        this.EmittedName(propSymbol, prop.Identifier.ValueText, GSharpIdentifierNameContext.Parameter),
                        type,
                        defaultValue: defaultValue
                    )
                )
                propertiesAsParams.Add(propSymbol)
            }
            if primaryParameters.Count == 0 && propertiesAsBodyFields.Count == 0 {
                return ConstructorLift.None
            }
            let reportedNames = propertiesAsParams
                .Concat(propertiesAsBodyFields)
                .Select((p IPropertySymbol) -> p.Name)
                .OrderBy((n string) -> n, StringComparer.Ordinal)
            this.context.Report(
                TranslationDiagnostic(
                    "RecordDeclaration",
                    "record '${record.Identifier.Text}' is canonicalized to a 'data class'/'data struct': body auto-property data member(s) ${string.Join(", ", reportedNames)} become primary-constructor parameter fields (now public and mutable), or — for a non-constant initializer that cannot be a valid G# optional-parameter default — a plain body field carrying that initializer (ADR-0115 §B.3/§B.4, issue #2228, issue #2281).",
                    record.GetLocation(),
                    TranslationSeverity.Info
                )
            )
            return ConstructorLift{
                Constructor: nil,
                DropConstructor: true,
                PrimaryParameters: primaryParameters,
                FieldsAsPrimaryParameters: HashSet[string](),
                PropertiesAsPrimaryParameters: propertiesAsParams,
                PropertiesAsBodyFields: propertiesAsBodyFields,
                FieldInitializers: Dictionary[string, GExpression](),
                BodyFieldInitializers: bodyFieldInitializers,
                ResidualInitStatements: List[GStatement]()
            }
        }

        private func AnalyzeConstructorLift(
            node TypeDeclarationSyntax,
            members IReadOnlyList[MemberDeclarationSyntax],
            symbol INamedTypeSymbol?,
            kind TypeDeclarationKind
        ) ConstructorLift {
            // Issues #2746/#2766: replacing any explicit class or plain-struct constructor with a G#
            // primary constructor changes its CLR contract. Assignment-target
            // names replace source parameter names, and private fields become
            // public. Keep both on the normal constructor/member paths.
            if kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.Struct {
                return ConstructorLift.None
            }
            // A C# `record struct` with an explicit (non-positional) constructor
            // cannot keep an in-body `init` member: the G# parser only accepts a
            // primary constructor on a `data struct`. Such a record-struct
            // constructor is therefore lifted to the primary constructor just like
            // a plain struct/class (ADR-0115 §B.3 / issue #1024 follow-up).
            let isRecordStructLift = kind == TypeDeclarationKind.DataStruct &&
                node is RecordDeclarationSyntax &&
                node.ParameterList == nil
            if symbol == nil ||
                (kind != TypeDeclarationKind.Class && kind != TypeDeclarationKind.Struct && !isRecordStructLift) {
                return ConstructorLift.None
            }
            let instanceCtors = members
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]()
                .Where(
                (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                )
            )
                .ToList()
            // A record already owns a primary constructor, and zero or many
            // instance constructors are out of scope for the L1 canonicalization.
            // The record-struct lift above is the sole exception: it has no
            // positional primary constructor and exactly one explicit one.
            if instanceCtors.Count != 1 || (node is RecordDeclarationSyntax && !isRecordStructLift) {
                return ConstructorLift.None
            }
            let ctor = instanceCtors[0]
            if ctor.Body == nil || ctor.Initializer != nil {
                return ConstructorLift.None
            }
            // Issue #1910: the constructor may be a merged-in member from a
            // different partial part/file; resolve it (and everything it
            // references) through that tree's own semantic model.
            using let modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree)
            let ctorSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(ctor) as IMethodSymbol
            if ctorSymbol == nil {
                return ConstructorLift.None
            }
            let paramToTarget = Dictionary[
                IParameterSymbol,
                (Name string, Type ITypeSymbol, Property IPropertySymbol?)
            ](SymbolEqualityComparer.Default)
            let fieldInitializers = Dictionary[string, GExpression]()
            let residualInitStatements = List[GStatement]()
            let previousScope = this.state.CurrentBodyScope
            this.state.CurrentBodyScope = ctor
            try {
                for statement in ctor.Body!!.Statements {
                    if statement is not Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ExpressionStatementSyntax exprStatement ||
                        exprStatement.Expression is not Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax assignment ||
                        !assignment
                        .OperatorToken
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EqualsToken) {
                        return ConstructorLift.None
                    }
                    // The assignment target is either a backing field or an
                    // auto-property (`Width = width`); both lift to a primary
                    // constructor parameter named after the member.
                    var targetName string
                    var targetType ITypeSymbol
                    var targetProperty IPropertySymbol?
                    let leftSymbol = this.context.GetSymbolInfo(assignment.Left).Symbol!!
                    if leftSymbol is IFieldSymbol fieldSymbol &&
                        !fieldSymbol.IsStatic &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(fieldSymbol.ContainingType, symbol) {
                        targetName = fieldSymbol.Name
                        targetType = fieldSymbol.Type
                        targetProperty = nil
                    } else if leftSymbol is IPropertySymbol propertySymbol &&
                        !propertySymbol.IsStatic &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(propertySymbol.ContainingType, symbol) {
                        targetName = propertySymbol.Name
                        targetType = propertySymbol.Type
                        targetProperty = propertySymbol
                        // Value types still lift because G# `struct`/`data struct`
                        // cannot carry an in-body `init` (ADR-0115 §B.3 / B.6 / T2).

                    } else {
                        return ConstructorLift.None
                    }
                    // `target = ctorParam` → lift to a primary-constructor parameter.
                    if assignment.Right is IdentifierNameSyntax rightId &&
                        this
                        .context
                        .GetSymbolInfo(rightId)
                        .Symbol is IParameterSymbol paramSymbol &&
                        SymbolEqualityComparer
                        .Default
                        .Equals(paramSymbol.ContainingSymbol, ctorSymbol) {
                        if paramToTarget.ContainsKey(paramSymbol) {
                            return ConstructorLift.None
                        }
                        paramToTarget[paramSymbol] = (targetName, targetType, targetProperty)
                        continue
                    }
                    // Otherwise the RHS must be independent of the constructor
                    // parameters to become a field initializer.
                    if this.ReferencesAnyParameter(assignment.Right, ctorSymbol) {
                        return ConstructorLift.None
                    }
                    // A G# field initializer is evaluated before the object is fully
                    // constructed, so it cannot reference any instance member of the
                    // type (an instance field/property/method, or `this`/`base`). Such
                    // an assignment must remain in the constructor body — keep it as a
                    // residual `init(...)` statement instead of hoisting it to a field
                    // initializer (defect: GS0125 'Variable doesn't exist' + cascade
                    // GS0159; e.g. `buffer = [InputBufferSize]T` where
                    // `InputBufferSize` is an abstract instance property). Static /
                    // constant RHS assignments still hoist normally.
                    if this.ReferencesInstanceMember(assignment.Right, symbol) {
                        residualInitStatements.Add(this.TranslateExpressionStatement(assignment)!!)
                        continue
                    }
                    // G# supports a field member initializer (`var Name T = expr`)
                    // but has no property member initializer (`prop Name T = expr`
                    // is rejected). A constant assignment to a property therefore
                    // cannot be lifted to a member initializer; keep the explicit
                    // 'init' so its body faithfully assigns the property.
                    if targetProperty != nil {
                        return ConstructorLift.None
                    }
                    // Issue #1729 (mode 5): hoisting a field initializer reorders it
                    // to the field's declaration position, ahead of every ctor
                    // statement that follows it in source. That is only safe when
                    // the assigned target is written exactly once (a repeat write
                    // would silently discard the first RHS's side effect via the
                    // dictionary overwrite below) and the RHS cannot itself run
                    // observable side effects (a call, object creation, or property
                    // getter) whose relative order versus other field initializers
                    // would then change. Either condition bails the whole lift so
                    // the explicit constructor — and its true evaluation order — is
                    // kept intact instead of silently reordered.
                    if fieldInitializers.ContainsKey(targetName) || this.ContainsPotentialSideEffect(assignment.Right) {
                        return ConstructorLift.None
                    }
                    fieldInitializers[targetName] = this.TranslateExpression(assignment.Right)!!
                }
            } finally {
                this.state.CurrentBodyScope = previousScope
            }
            // Every constructor parameter must be consumed by exactly one direct
            // member assignment for the constructor to drop cleanly.
            if ctorSymbol.Parameters.Any((p IParameterSymbol) -> !paramToTarget.ContainsKey(p)) {
                return ConstructorLift.None
            }
            // An instance-member-dependent assignment must stay in the constructor
            // body (see above). It is emitted as a synthesized parameterless
            // `init() { ... }`, which cannot coexist with a primary constructor that
            // carries parameters. When the constructor also copies parameters into
            // members, leave the whole explicit constructor intact rather than emit a
            // conflicting primary-ctor + init pair (still valid G#).
            if residualInitStatements.Count > 0 && ctorSymbol.Parameters.Length > 0 {
                return ConstructorLift.None
            }
            let primaryParameters = List[Parameter]()
            let fieldsAsParams = HashSet[string]()
            let propertiesAsParams = HashSet[IPropertySymbol](SymbolEqualityComparer.Default)
            for param in ctorSymbol.Parameters {
                let target = paramToTarget[param]
                var type = this.typeMapper.Map(target.Type, this.context, param.Locations.FirstOrDefault())
                // Issue #914 (oblivious sink): a T2-lifted primary-constructor
                // parameter must receive the SAME oblivious-nullability promotion
                // as an ordinary parameter (MapParameter) — otherwise a reference
                // (incl. function-typed) parameter that is null-conditionally used
                // (`report?(…)`) or receives a promoted-nullable argument at a
                // `base(...)`/`this(...)` call site keeps its non-nullable header
                // type, so the lifted primary ctor's arity/signature no longer
                // matches the promoted argument a derived ctor forwards (GS0214).
                // Both helpers no-op for a nullable-enabled compilation and are
                // already guarded to reference types, so value-type params are
                // untouched.
                type = this.PromoteIfUsedAsNullable(type, param)!!
                type = this.PromoteDelegateParameterInvokedWithNull(type, param)!!
                let liftedDefault = this.BuildOptionalParameterDefault(param, type, node)
                let targetSymbol = target.Property ?? ctorSymbol.ContainingType.GetMembers(target.Name).FirstOrDefault()
                primaryParameters.Add(
                    Parameter(
                        this.EmittedName(targetSymbol, target.Name, GSharpIdentifierNameContext.Parameter),
                        type,
                        defaultValue: liftedDefault
                    )
                )
                if target.Property != nil {
                    propertiesAsParams.Add(target.Property!!)
                } else {
                    fieldsAsParams.Add(target.Name)
                }
            }
            let allParamNames = fieldsAsParams
                .Concat(propertiesAsParams.Select((p IPropertySymbol) -> p.Name))
                .OrderBy((n string) -> n)
                .ToList()
            if allParamNames.Count > 0 {
                this.context.Report(
                    TranslationDiagnostic(
                        "ConstructorDeclaration",
                        "constructor on '${node.Identifier.Text}' is canonicalized to a primary constructor: parameter-sourced member(s) ${string.Join(", ", allParamNames)} become primary-constructor parameter fields (now public) and the explicit 'init' is dropped (ADR-0115 §B.3 / T2).",
                        ctor.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            return ConstructorLift{
                Constructor: ctor,
                DropConstructor: true,
                PrimaryParameters: primaryParameters,
                FieldsAsPrimaryParameters: fieldsAsParams,
                PropertiesAsPrimaryParameters: propertiesAsParams,
                FieldInitializers: fieldInitializers,
                ResidualInitStatements: residualInitStatements
            }
        }

        private func ReferencesAnyParameter(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            ctorSymbol IMethodSymbol
        ) bool {
            for id in expression.DescendantNodesAndSelf().OfType[IdentifierNameSyntax]() {
                if this.context.GetSymbolInfo(id).Symbol is IParameterSymbol p && SymbolEqualityComparer.Default.Equals(
                    p.ContainingSymbol,
                    ctorSymbol
                ) {
                    return true
                }
            }
            return false
        }

        /// Determines whether [`expression`](paramref) reads any instance
        /// member of the type under construction — an instance field, property,
        /// method or event accessed without a static qualifier, or an explicit
        /// `this`/`base` expression. Such an expression cannot be lifted
        /// into a G# field initializer (it would reference object state before the
        /// instance exists, GS0125) and must stay in the constructor body.
        private func ReferencesInstanceMember(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            containingType INamedTypeSymbol
        ) bool {
            for node in expression.DescendantNodesAndSelf() {
                if node is ThisExpressionSyntax || node is BaseExpressionSyntax {
                    return true
                }
                if node is not SimpleNameSyntax name {
                    continue
                }
                // Only the leftmost name of a member-access chain (`a.B.C`) binds to
                // a member/local in the current scope; the trailing names resolve
                // against another receiver's type, so skip them.
                if node.Parent is MemberAccessExpressionSyntax memberAccess && memberAccess.Name == node {
                    continue
                }
                // Issue #4918: a name can bind to no symbol (an unresolved name, or one
                // Roslyn only resolves as part of a larger construct); that is a "no",
                // not a crash, so keep the symbol nullable and test it.
                let symbol = this.context.GetSymbolInfo(name).Symbol
                if symbol != nil &&
                    symbol.IsStatic == false &&
                    (
                    symbol.Kind == SymbolKind.Field ||
                        symbol.Kind == SymbolKind.Property ||
                        symbol.Kind == SymbolKind.Method ||
                        symbol.Kind == SymbolKind.Event
                ) &&
                    symbol.ContainingType != nil &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType!!) {
                    return true
                }
            }
            return false
        }

        private func IsArrayFieldOverwrittenBeforeObservation(field IFieldSymbol) bool {
            let owner = field.ContainingType!!
            // ponytail: prove only straight-line constructor prefixes on sealed,
            // object-based types without finalizers; all other shapes keep fresh zeros.
            if !owner.IsSealed ||
                owner
                .BaseType
                ?.SpecialType != SpecialType.System_Object ||
                owner
                .GetMembers()
                .OfType[IMethodSymbol]()
                .Any((method IMethodSymbol) -> method.MethodKind == MethodKind.Destructor) {
                return false
            }
            for constructor in owner.InstanceConstructors {
                if constructor
                    .DeclaringSyntaxReferences
                    .Length != 1 ||
                    constructor
                    .DeclaringSyntaxReferences[0]
                    .GetSyntax() is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConstructorDeclarationSyntax syntax ||
                    syntax.Body == nil ||
                    syntax.Initializer != nil {
                    return false
                }
                using let modelScope = this.context.UseSemanticModelFor(syntax.SyntaxTree)
                var overwritten = false
                for statement in syntax.Body!!.Statements {
                    if statement is not Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionStatementSyntax expression {
                        return false
                    }
                    if expression.Expression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax assignment &&
                        assignment
                        .IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) {
                        let left = StripParentheses(assignment.Left)
                        let directReceiver = left is IdentifierNameSyntax ||
                            (
                            left is MemberAccessExpressionSyntax access &&
                                StripParentheses(access.Expression) is ThisExpressionSyntax
                        )
                        if directReceiver &&
                            this
                            .context
                            .GetSymbolInfo(left)
                            .Symbol is IFieldSymbol assigned &&
                            !assigned.IsStatic &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(assigned.ContainingType, owner) {
                            if this.ReferencesInstanceMember(assignment.Right, owner) {
                                return false
                            }
                            if SymbolEqualityComparer.Default.Equals(assigned, field) {
                                overwritten = true
                                break
                            }
                            continue
                        }
                    }
                    if this.ReferencesInstanceMember(expression.Expression, owner) {
                        return false
                    }
                }
                if !overwritten {
                    return false
                }
            }
            return owner.InstanceConstructors.Length > 0
        }

        /// Issue #1729 (mode 5): determines whether hoisting [`expression`](paramref)
        /// to a field's declaration position could change observable behavior versus
        /// leaving it in the constructor body — a method/delegate invocation or
        /// property-getter access may run arbitrary code (I/O, mutation, logging)
        /// whose order relative to other field initializers would then differ from
        /// C#'s constructor-body order. Plain reads of fields, locals, parameters,
        /// constants, and object construction (the idiomatic
        /// `_field = new T(...)` field-initializer shape, ADR-0115 §B.3 / T2)
        /// are treated as side-effect-free and remain safe to hoist.
        private func ContainsPotentialSideEffect(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
        ) bool {
            for node in expression.DescendantNodesAndSelf() {
                switch node {
                    case InvocationExpressionSyntax,
                    Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AwaitExpressionSyntax,
                    Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax,
                    PostfixUnaryExpressionSyntax {
                        return true
                    }
                    case prefix is PrefixUnaryExpressionSyntax when prefix.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreIncrementExpression
                    ) ||
                        prefix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreDecrementExpression) {
                        return true
                    }
                }
                if node is SimpleNameSyntax name && this.context.GetSymbolInfo(name).Symbol is IPropertySymbol {
                    // A property access may run an arbitrary getter body.
                    return true
                }
            }
            return false
        }

        /// Issue #1729 (mode 3): determines whether [`expression`](paramref)
        /// reads any static member of [`containingType`](paramref) (or a base
        /// of it) — a static field, property, method, or event. A folded static
        /// constructor assignment whose RHS depends on the type's own static state
        /// cannot be hoisted to its field's declaration position without risking a
        /// change to C#'s field-initializers-then-cctor evaluation order.
        private func ReferencesStaticMemberOfType(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            containingType INamedTypeSymbol
        ) bool {
            for node in expression.DescendantNodesAndSelf() {
                if node is not SimpleNameSyntax name {
                    continue
                }
                // Issue #4918: a name can bind to no symbol (an unresolved name, or one
                // Roslyn only resolves as part of a larger construct); that is a "no",
                // not a crash, so keep the symbol nullable and test it.
                let symbol = this.context.GetSymbolInfo(name).Symbol
                if symbol != nil &&
                    symbol.IsStatic == true &&
                    (
                    symbol.Kind == SymbolKind.Field ||
                        symbol.Kind == SymbolKind.Property ||
                        symbol.Kind == SymbolKind.Method ||
                        symbol.Kind == SymbolKind.Event
                ) &&
                    symbol.ContainingType != nil &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType!!) {
                    return true
                }
            }
            return false
        }

        shared {
            // Issue #4350: whether `node` (a simple name, or the member access that
            // carries it) is written: an assignment's left side, an increment or
            // decrement operand, or an element of a deconstruction target.
            private func IsWriteTarget(node Microsoft.CodeAnalysis.SyntaxNode?) bool {
                var current Microsoft
                    .CodeAnalysis
                    .SyntaxNode? = if node!!.Parent is MemberAccessExpressionSyntax memberAccess &&
                    memberAccess.Name == node {
                    cast[Microsoft.CodeAnalysis.SyntaxNode](memberAccess)
                } else {
                    node
                }
                while current!!.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax {
                    current = current!!.Parent
                }
                while current!!.Parent is ArgumentSyntax{Parent: TupleExpressionSyntax tuple} {
                    current = tuple
                }
                return switch current!!.Parent {
                    case assignment is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax: assignment.Left == current
                    case prefix is PrefixUnaryExpressionSyntax: prefix.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreIncrementExpression
                    ) ||
                        prefix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PreDecrementExpression)
                    case postfix is PostfixUnaryExpressionSyntax: postfix.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.PostIncrementExpression
                    ) ||
                        postfix.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PostDecrementExpression)
                    default: false
                }
            }

            /// Whether [`symbol`](paramref) is reachable only through an
            /// explicit interface slot rather than through its containing type.
            private func IsExplicitInterfaceImplementation(symbol ISymbol) bool -> switch symbol {
                case method is IMethodSymbol: !method.ExplicitInterfaceImplementations.IsDefaultOrEmpty
                case property is IPropertySymbol: !property.ExplicitInterfaceImplementations.IsDefaultOrEmpty
                case event is IEventSymbol: !event.ExplicitInterfaceImplementations.IsDefaultOrEmpty
                default: false
            }

            /// Issue #950: returns `true` when [`type`](paramref)
            /// declares any member with a `protected`-family accessibility.
            /// Such a class is intended for inheritance, so it must be emitted as an
            /// `open class` for the G# `protected` modifier to be valid.
            private func HasProtectedMember(type INamedTypeSymbol?) bool {
                // Issue #4674: a C# `sealed` type is emitted as a non-`open` G# class
                // (CLR-sealed), and `protected` is valid there only on an `override`
                // (its accessibility is dictated by the base member, so gsc exempts
                // it from GS0380). Only an explicit non-override `protected` member
                // of a sealed type still forces `open`; counting the others made
                // `Lowerer` and every sealed record (whose compiler-synthesized
                // `EqualityContract`/`PrintMembers` are `protected`) un-sealed.
                //
                // `protected internal` / `private protected` are emitted as
                // `internal` (see MapVisibility), so they never need `open` for the
                // sealed case either (`FunctionSymbol`'s `private protected override`).
                let isSealed = type!!.IsSealed
                for member in type!!.GetMembers() {
                    switch member.DeclaredAccessibility {
                        case Accessibility.Protected {
                            if !isSealed || (!member.IsImplicitlyDeclared && !member.IsOverride) {
                                return true
                            }
                        }
                        case Accessibility.ProtectedOrInternal, Accessibility.ProtectedAndInternal {
                            if !isSealed {
                                return true
                            }
                        }
                        default {
                            let _ = 0
                        }
                    }
                }
                return false
            }

            /// Issue #4674: whether [`type`](paramref) and every type enclosing it
            /// are reachable from another assembly (public, protected or protected
            /// internal), i.e. whether the type is part of the assembly's API.
            private func IsExternallyVisible(type INamedTypeSymbol?) bool {
                for var current INamedTypeSymbol? = type; current != nil; current = current!!.ContainingType {
                    switch current.DeclaredAccessibility {
                        case Accessibility.Public, Accessibility.Protected, Accessibility.ProtectedOrInternal { }
                        default {
                            return false
                        }
                    }
                }
                return true
            }

            /// Issue #3724: returns `true` when [`type`](paramref)
            /// declares a `virtual` or `abstract` member that another assembly
            /// could override.
            ///
            /// `CollectSubclassedBaseTypes` only walks
            /// `compilation.Assembly.GlobalNamespace`, so a base class whose only
            /// subclass lives in a *referencing* project — the
            /// `src/LanguageServer` / `test/LanguageServer.Tests` split, and
            /// every other "the test project derives a fake from the production type"
            /// pattern — was emitted as a plain (that is, CLR-sealed) `class` with
            /// non-`open` members. The derived project then failed to compile:
            /// GS0157 on the base clause, GS0183 on the `override`.
            ///
            /// A C# author who writes `virtual` on a non-sealed type has already
            /// declared the inheritance intent explicitly, so carry that intent across
            /// the assembly boundary rather than re-deriving it from the in-project
            /// subclasses that happen to be visible. Only members that are already
            /// virtual in C# gain `open` ((cref:IsMemberEmittedOpen) gates on
            /// the same predicate), so the emitted vtable shape is unchanged.
            private func DeclaresOverridableMember(type INamedTypeSymbol?) bool {
                for member in type!!.GetMembers() {
                    if member.IsSealed ||
                        member.DeclaredAccessibility == Accessibility.Private ||
                        !(member.IsVirtual || member.IsAbstract) {
                        continue
                    }
                    switch member.Kind {
                        case SymbolKind.Method, SymbolKind.Property, SymbolKind.Event {
                            return true
                        }
                        default {
                            let _ = 0
                        }
                    }
                }
                return false
            }

            private func MapAggregateKind(node BaseTypeDeclarationSyntax) TypeDeclarationKind? {
                switch node {
                    case ClassDeclarationSyntax {
                        return TypeDeclarationKind.Class
                    }
                    case Microsoft.CodeAnalysis.CSharp.Syntax.StructDeclarationSyntax {
                        return TypeDeclarationKind.Struct
                    }
                    case Microsoft.CodeAnalysis.CSharp.Syntax.InterfaceDeclarationSyntax {
                        return TypeDeclarationKind.Interface
                    }
                    case record is RecordDeclarationSyntax {
                        return if record.ClassOrStructKeyword.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.StructKeyword
                        ) {
                            TypeDeclarationKind.DataStruct
                        } else {
                            TypeDeclarationKind.DataClass
                        }
                    }
                    default {
                        return nil
                    }
                }
            }

            private func IsValueAggregate(kind TypeDeclarationKind) bool -> kind == TypeDeclarationKind.Struct ||
                kind == TypeDeclarationKind.DataStruct

            private func IsFieldlessRecord(record RecordDeclarationSyntax) bool {
                // Issue #2363: an explicit-but-empty positional parameter list
                // (`record Name()`) still declares positional record *shape* — it
                // is a genuine (zero-arity) primary constructor, distinct from a
                // record with no parameter list at all (`record Name;`). Only the
                // latter is truly "fieldless"; `record Name()` maps to a G# `data
                // class`/`data struct` with zero fields (now supported by gsc —
                // GS0104 no longer rejects an empty-field data type) so it must
                // NOT be downgraded to a plain class/struct merely because its
                // primary constructor happens to have zero parameters.
                let hasPositional = record.ParameterList != nil
                let hasDataMember = record.Members.Any(
                    (m MemberDeclarationSyntax) -> (
                        m is Microsoft.CodeAnalysis.CSharp.Syntax.FieldDeclarationSyntax field && !field.Modifiers.Any(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                        ) &&
                            !field
                            .Modifiers
                            .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ConstKeyword)
                    ) ||
                        (
                        m is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .PropertyDeclarationSyntax property &&
                            !property
                            .Modifiers
                            .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword)
                    )
                )
                return !hasPositional && !hasDataMember
            }

            /// Determines whether a C# record declares an instance auto-property data
            /// member in its body (e.g. `public string Title { get; }` or
            /// `{ get; init; }`). A G# `data` type's fields come exclusively
            /// from its positional primary-constructor parameters; auto-properties are
            /// rejected (GS0189) and a body-only record has no `data` fields at all
            /// (GS0104). Such records therefore map to a plain `class`/`struct`
            /// (OD-T5).
            private func RecordHasAutoPropertyDataMember(record RecordDeclarationSyntax) bool {
                return record
                    .Members
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax]()
                    .Any(
                    (p Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax) -> !p.Modifiers.Any(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    ) &&
                        p.ExpressionBody == nil &&
                        p.AccessorList != nil &&
                        p.AccessorList!!
                        .Accessors
                        .All((a AccessorDeclarationSyntax) -> a.Body == nil && a.ExpressionBody == nil) &&
                        p.AccessorList!!
                        .Accessors
                        .Any(
                        (a AccessorDeclarationSyntax) -> a.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                        )
                    )
                )
            }

            /// Determines whether a property participates in a contract that requires it
            /// to remain a real property in G# — it implements an interface property or
            /// is part of an override chain (virtual/abstract/override). Such a property
            /// cannot be lifted into a primary-constructor parameter (G# primary-ctor
            /// parameters are not properties), or the contract breaks (GS0187). OD-T1.
            private func IsContractProperty(property IPropertySymbol) bool {
                if property.IsVirtual || property.IsAbstract || property.IsOverride {
                    return true
                }
                let containing INamedTypeSymbol? = property.ContainingType
                if containing == nil {
                    return false
                }
                for iface in containing.AllInterfaces {
                    for ifaceProperty in iface.GetMembers().OfType[IPropertySymbol]() {
                        let implementation ISymbol? = containing.FindImplementationForInterfaceMember(ifaceProperty)
                        if SymbolEqualityComparer.Default.Equals(implementation, property) {
                            return true
                        }
                    }
                }
                return false
            }

            private func IsIntegral(value object?) bool -> value is uint8 ||
                value is int8 ||
                value is int16 ||
                value is uint16 ||
                value is int32 ||
                value is uint32 ||
                value is int64 ||
                value is uint64

            /// Determines whether a C# property is a plain auto-property whose value
            /// is set only during construction — bodyless `{ get; }` or
            /// `{ get; init; }`. Consumers requiring a truly getter-only
            /// contract must also require the Roslyn property's SetMethod to be absent.
            private func IsGetOnlyAutoProperty(
                prop Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax
            ) bool {
                if prop.ExpressionBody != nil || prop.AccessorList == nil {
                    return false
                }
                let accessors IReadOnlyList[AccessorDeclarationSyntax] = prop.AccessorList!!.Accessors
                if accessors.Any((a AccessorDeclarationSyntax) -> a.Body != nil || a.ExpressionBody != nil) {
                    return false
                }
                let hasGet = accessors.Any(
                    (a AccessorDeclarationSyntax) -> a.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                    )
                )
                let hasSet = accessors.Any(
                    (a AccessorDeclarationSyntax) -> a.IsKind(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.SetAccessorDeclaration
                    )
                )
                return hasGet && !hasSet
            }

            private func HasDesignatedInstanceConstructor(members IReadOnlyList[MemberDeclarationSyntax]) bool {
                return members.OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax]().Any(
                    (c Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax) -> !c.Modifiers.Any(
                        Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword
                    ) &&
                        (
                        c.Initializer == nil || c.Initializer!!.ThisOrBaseKeyword.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.BaseKeyword
                        )
                    )
                )
            }

            /// Issue #1733: `double`/`float`'s special non-finite values
            /// (`NaN`, `PositiveInfinity`, `NegativeInfinity`) have no
            /// numeric-literal spelling — `d.ToString(CultureInfo.InvariantCulture)`
            /// renders them as the bare words `"NaN"`/`"Infinity"`/
            /// `"-Infinity"`, which G# reads as unresolved identifiers. G# exposes
            /// the BCL fields directly (`System.Double.NaN`, `System.Single.NaN`, …;
            /// see `Issue1616FloatNaNOperatorEmitTests`/`Issue1617…`), so those
            /// are emitted as a fully-qualified member reference instead — qualified so
            /// the reference resolves even when the C# source has no `using
            /// System;` (a bare `double`/`float` default never requires
            /// one).
            /// @param value The floating-point value.
            /// @param isDouble Whether [`value`](paramref) is a `double` (vs. `float`).
            /// @returns The qualified BCL member reference, or `null` when [`value`](paramref) is an ordinary
            /// finite value.
            private func MapSpecialFloatConstant(value float64, isDouble bool) GExpression? {
                let owner = if isDouble {
                    "System.Double"
                } else {
                    "System.Single"
                }
                if float64.IsNaN(value) {
                    return MemberAccessExpression(IdentifierExpression(owner), "NaN")
                }
                if float64.IsPositiveInfinity(value) {
                    return MemberAccessExpression(IdentifierExpression(owner), "PositiveInfinity")
                }
                if float64.IsNegativeInfinity(value) {
                    return MemberAccessExpression(IdentifierExpression(owner), "NegativeInfinity")
                }
                return nil
            }

            /// Issue #1733 N2: reinterprets a boxed enum-underlying-type value as its
            /// raw 64-bit pattern so equality/bitwise comparisons never throw
            /// (cref:System.OverflowException) — `Convert.ToInt64` throws for
            /// any `ulong` value above `long.MaxValue`, and a naive
            /// `Convert.ToUInt64` throws for any negative signed value. Unsigned
            /// underlying types (`byte`/`ushort`/`uint`/`ulong`)
            /// convert straight to `ulong`; signed types (`sbyte`/`short`/
            /// `int`/`long`, and any other/unknown underlying type) go through
            /// `long` first and reinterpret its two's-complement bits as
            /// `ulong` — equality and bitwise AND/OR/NOT are bit-pattern operations,
            /// so this reinterpretation is exact for both comparisons and [Flags]
            /// decomposition regardless of signedness.
            private func ToEnumBitPattern(value object?, underlyingType SpecialType) uint64 {
                return switch underlyingType {
                    case SpecialType.System_Byte or
                        SpecialType.System_UInt16 or
                        SpecialType.System_UInt32 or
                        SpecialType.System_UInt64: Convert.ToUInt64(value, CultureInfo.InvariantCulture)
                    default: unchecked(uint64(Convert.ToInt64(value, CultureInfo.InvariantCulture)))
                }
            }

            private func IsExtensionMethodDeclaration(
                member MemberDeclarationSyntax
            ) bool -> member is MethodDeclarationSyntax method &&
                method
                .ParameterList
                .Parameters
                .Count > 0 &&
                method
                .ParameterList
                .Parameters[0]
                .Modifiers
                .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ThisKeyword)

            private func InheritsFromOrEquals(type INamedTypeSymbol, candidateBase INamedTypeSymbol) bool {
                for var current INamedTypeSymbol? = type; current != nil; current = current!!.BaseType {
                    if SymbolEqualityComparer.Default.Equals(
                        current.OriginalDefinition,
                        candidateBase.OriginalDefinition
                    ) {
                        return true
                    }
                }
                return false
            }
        }
    }
}
