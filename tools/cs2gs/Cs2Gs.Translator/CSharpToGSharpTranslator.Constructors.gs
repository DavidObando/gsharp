// <copyright file="CSharpToGSharpTranslator.Constructors.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
import GSharpIdentifierNameContext = GSharp.Core.CodeAnalysis.Syntax.IdentifierNameContext
import GSharpSyntaxFacts = GSharp.Core.CodeAnalysis.Syntax.SyntaxFacts
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
        private let liftedHelperOccupiedSymbolsByScope Dictionary[ISymbol, IReadOnlyList[ISymbol]] = Dictionary[
            ISymbol,
            IReadOnlyList[ISymbol]
        ](SymbolEqualityComparer.Default)

        // Parameter docs use semantic names, not `$`-escaped source spellings.
        // Drop an extension receiver's @param: it becomes a receiver clause,
        // not an ordinary G# parameter.
        private func SanitizeDocParamComments(node GNode?, source Microsoft.CodeAnalysis.SyntaxNode) {
            if node?.AttachedComments is not{Count: > 0} comments || !comments.Any(
                (l string) -> l.Contains("@param", StringComparison.Ordinal)
            ) {
                return
            }
            let method IMethodSymbol? = this.context.GetDeclaredSymbol(source) as IMethodSymbol
            let parameters = method?.Parameters ??
                (this.context.GetDeclaredSymbol(source) as IPropertySymbol)?.Parameters ??
                ImmutableArray[IParameterSymbol].Empty
            if parameters.IsDefaultOrEmpty {
                return
            }
            let receiverName string? = if method != nil && method.IsExtensionMethod == true {
                parameters[0].Name
            } else {
                default(string?)
            }
            let updated = List[string](comments.Count)
            for line in comments {
                let at = line.IndexOf("@param ", StringComparison.Ordinal)
                if at < 0 {
                    updated.Add(line)
                    continue
                }
                let nameStart = at + "@param ".Length
                var nameEnd = nameStart
                while nameEnd < line.Length && !char.IsWhiteSpace(line[nameEnd]) {
                    nameEnd++
                }
                let documented = line.Substring(nameStart, nameEnd - nameStart)
                if documented == receiverName {
                    continue
                }
                updated.Add(line)
            }
            node!!.AttachedComments = updated
        }

        private func TranslateIndexer(node IndexerDeclarationSyntax)(Member GMember?, IsStatic bool) {
            // ADR-0118 / issue #944: a C# indexer (`public T this[int i] => ...`)
            // maps to the canonical G# indexer member (`prop this[i int32] T`).
            let symbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            let isStatic = symbol != nil && symbol.IsStatic
            // Issue #3879 (ADR-0060 amendment): a C# `ref` INDEXER now has a
            // canonical G# form — `prop this[i int32] ref T { get { return ref
            // lvalue } }` and its arrow sugar. See the twin comment in
            // TranslateProperty for the matching readonly capability.
            var isRefReturnIndexer = symbol != nil && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly)
            // Issue #3879: the twin of the abstract/interface gap in
            // TranslateProperty — gsc's by-ref form is concrete-only, so an
            // abstract or interface-declared `ref` indexer must gap HERE rather
            // than be emitted and refused later by gsc's GS0578.
            if symbol != nil &&
                isRefReturnIndexer &&
                (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface) {
                let abstractRefIndexerMessage = "ref-returning indexer is abstract or declared on an interface, which has no G# form: G#'s by-ref " +
                    "property (issue #3879, ADR-0060 §14) is a concrete, computed-getter form only, because a slot " +
                    "names nothing to alias and an implementor could satisfy a `ref` requirement with a copy-returning " +
                    "indexer unchecked. A concrete `ref` indexer translates."
                this.context.ReportUnsupported(node, abstractRefIndexerMessage)
                isRefReturnIndexer = false
            }
            // ADR-0149 (issue #944 follow-up): G# interfaces can now declare an
            // indexer MEMBER (the prior gsc limitation — DeclarationBinder
            // unconditionally rejecting `this[...]` inside an `interface` body
            // — has been removed), so an indexer implementing a G# USER
            // interface member now uses the exact same explicit-interface
            // qualifier clause (`prop (IFoo) this[...] T`) as an ordinary
            // property or method (issue #2010 / #2362 / ADR-0149), instead of
            // the #1911-style forced-public collision-drop fallback. Imported
            // CLR interfaces use the clause too.
            let isExplicitInterfaceIndexerImpl = symbol != nil && symbol.ExplicitInterfaceImplementations.Length > 0
            let usesExplicitInterfaceIndexerClause = isExplicitInterfaceIndexerImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length == 1
            if isExplicitInterfaceIndexerImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length > 1 &&
                symbol!!
                .ExplicitInterfaceImplementations
                .All((e IPropertySymbol) -> e.ContainingType.Locations.Any((l Location) -> l.IsInSource)) {
                let names = string.Join(
                    ", ",
                    symbol!!.ExplicitInterfaceImplementations.Select((e IPropertySymbol) -> e.ContainingType.Name)
                )
                let multiEntryMessage = "explicit interface indexer implementation '${FormatExplicitInterfacePropertyName(symbol)}' satisfies " +
                    "more than one G# user interface member in one C# declaration ($names), likely via interface " +
                    "inheritance (a base interface re-declaring the same indexer). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per indexer, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the indexer keeps its plain \"this[]\" " +
                    "form and every interface's slot is satisfied via ordinary implicit signature dispatch (known gap: " +
                    "the indexer becomes publicly callable through any interface reference, unlike real C# explicit-impl " +
                    "semantics)."
                this.context.Report(
                    TranslationDiagnostic(
                        "IndexerDeclaration",
                        multiEntryMessage,
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            if isExplicitInterfaceIndexerImpl && !usesExplicitInterfaceIndexerClause {
                let indexerSurvivor IPropertySymbol? = FindPriorCollidingSiblingProperty(symbol, node)
                if indexerSurvivor != nil {
                    let message = "explicit interface indexer implementation '${symbol!!.ContainingType.Name}.${FormatExplicitInterfacePropertyName(symbol)}' " +
                        "shares its parameter shape with '${symbol!!.ContainingType.Name}.${FormatSiblingPropertyName(indexerSurvivor)}'; " +
                        "one C# declaration targets multiple interface slots, while ADR-0149 carries one qualifier, so the " +
                        "two indexers cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by parameter shape; if the surviving sibling's accessors differ from this dropped declaration's, " +
                        "any C# access through the interface-typed reference that previously reached this indexer now " +
                        "silently observes the surviving indexer instead (semantic loss, known gap, issue #1911 " +
                        "analogue). Separate explicit declarations with distinct qualifiers are fully supported (issue " +
                        "#944 follow-up, ADR-0149 explicit-interface clause)."
                    this.context.Report(
                        TranslationDiagnostic(
                            "IndexerDeclaration",
                            message,
                            node.GetLocation(),
                            TranslationSeverity.Unsupported
                        )
                    )
                    return (nil, false)
                }
            }
            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a single-slot explicit indexer implementation, or null otherwise.
            let explicitInterfaceIndexerType GTypeReference? = if usesExplicitInterfaceIndexerClause {
                this.typeMapper.Map(
                    symbol!!.ExplicitInterfaceImplementations[0].ContainingType,
                    this.context,
                    node.GetLocation()
                )
            } else {
                default(GTypeReference?)
            }
            var type GTypeReference? = if symbol != nil {
                this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            // Issue #2157 / #1354: an oblivious indexer whose getter yields a
            // nullable value (`?.` / `??` / `return null`), or one null-checked
            // in its declaring type, is rendered `T?` so the getter body
            // type-checks.
            if symbol != nil {
                type = this.PromoteIfUsedAsNullable(type, symbol)
            }
            let indexParameters = if symbol != nil {
                symbol.Parameters.Select((p IParameterSymbol) -> this.MapParameter(p, node)).ToList()
            } else {
                this.MapParameterList(node.ParameterList)
            }
            var accessors = this.MapAccessors(node, "indexer 'this[]'")
            // Issue #1278 / ADR-0131: a C# expression-bodied indexer
            // (`public T this[int i] => expr;`) renders as the idiomatic G#
            // indexer-level arrow `prop this[i T] U -> expr`.
            let arrowBody GStatement? = TryFoldComputedPropertyArrow(
                node.ExpressionBody,
                accessors,
                allowRefReturn: isRefReturnIndexer
            )
            if arrowBody != nil {
                accessors = List[PropertyAccessor]()
            }
            let isOverride = symbol != nil && symbol.IsOverride
            let isAbstract = symbol?.IsAbstract == true && symbol!!.ContainingType.TypeKind != TypeKind.Interface
            let isOpen = !isAbstract && this.IsMemberEmittedOpen(symbol, isOverride)
            // ADR-0149: see the matching visibility comment in
            // TranslatePropertyDeclaration for the full rationale — a G#
            // user-interface explicit indexer implementation (explicit-
            // interface clause + CLR MethodImpl) keeps C#'s own
            // `private`-equivalent visibility (Roslyn reports `Private`,
            // mapped straight through by MapVisibility).
            let indexerVisibility = if isExplicitInterfaceIndexerImpl && !usesExplicitInterfaceIndexerClause {
                Visibility.Default
            } else {
                MapVisibility(symbol, this.context, node)
            }
            let property = PropertyDeclaration(
                "this",
                type,
                accessors: accessors,
                visibility: indexerVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapPropertyAttributes(node),
                indexerParameters: indexParameters,
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfaceIndexerType,
                isRefReturn: isRefReturnIndexer,
                isReadOnlyRefReturn: symbol?.ReturnsByRefReadonly == true,
                isAbstract: isAbstract
            )
            return (property, isStatic)
        }

        private func MapAccessors(
            node BasePropertyDeclarationSyntax,
            displayName string,
            fieldKeywordBackingName string? = nil
        ) List[PropertyAccessor] {
            // An expression-bodied property (=> expr) is a get-only computed
            // property; its body is deferred to step 7 (ADR-0115 §B.11).
            let expressionBody ArrowExpressionClauseSyntax? = switch node {
                case p is Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax: p.ExpressionBody
                case i is IndexerDeclarationSyntax: i.ExpressionBody
                default: default(ArrowExpressionClauseSyntax?)
            }
            if expressionBody != nil {
                return List[PropertyAccessor]{
                    PropertyAccessor(
                        Cs2Gs.CodeModel.Ast.AccessorKind.Get,
                        this.TranslateBody(node, "$displayName getter")
                    )
                }
            }
            if node.AccessorList == nil {
                return List[PropertyAccessor]()
            }
            let declared IReadOnlyList[AccessorDeclarationSyntax] = node.AccessorList!!.Accessors
            let propertySymbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            let isContract = propertySymbol != nil &&
                (propertySymbol.IsAbstract || propertySymbol.ContainingType?.TypeKind == TypeKind.Interface)
            let anyBodied = declared.Any((a AccessorDeclarationSyntax) -> a.Body != nil || a.ExpressionBody != nil)
            let hasSet = declared.Any(
                (a AccessorDeclarationSyntax) -> a.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.SetAccessorDeclaration
                )
            )
            let hasGet = declared.Any(
                (a AccessorDeclarationSyntax) -> a.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                )
            )
            let hasInit = declared.Any(
                (a AccessorDeclarationSyntax) -> a.IsKind(
                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.InitAccessorDeclaration
                )
            )
            // A read-write auto-property (all accessors body-less, has get + set)
            // maps to the canonical auto form `prop Name T` (ADR-0115 §B.11). An
            // init-only auto-property (get + init) keeps its explicit accessors so
            // the init-only semantics are preserved (issue #946).
            if !anyBodied && !isContract && hasGet && hasSet && fieldKeywordBackingName == nil && declared.All(
                (a AccessorDeclarationSyntax) -> a.Modifiers.Count == 0
            ) {
                return List[PropertyAccessor]()
            }
            // OD-T1: a C# get-only auto-property (`{ get; }`, body-less, no set/init)
            // is settable in the declaring type's constructor. Issue #4350: G#
            // follows the same rule for an instance `{ get; }` auto-property, so
            // it keeps its get-only shape and ABI — no `set_P`/`init` accessor
            // appears in metadata. Static, virtual, and override members are
            // lowered by TranslateProperty to a private backing field plus an
            // arrow getter (G# has no user static constructor body, and a
            // body-less `open`/`override` `{ get; }` declares an abstract
            // slot), so the `{ get; init; }` spelling below is only a fallback
            // that property never reaches. Interface/abstract contract members
            // carry no backing field and remain read-only contracts.
            if !anyBodied && hasGet && !hasSet && !hasInit {
                let keepsGetOnlyShape = propertySymbol != nil &&
                    !propertySymbol.IsStatic &&
                    !propertySymbol.IsVirtual &&
                    !propertySymbol.IsOverride
                if !isContract && keepsGetOnlyShape {
                    return List[PropertyAccessor]{PropertyAccessor(Cs2Gs.CodeModel.Ast.AccessorKind.Get, nil)}
                }
                if !isContract {
                    return List[PropertyAccessor]{
                        PropertyAccessor(Cs2Gs.CodeModel.Ast.AccessorKind.Get, nil),
                        PropertyAccessor(Cs2Gs.CodeModel.Ast.AccessorKind.Init, nil)
                    }
                }
            }
            let accessors = List[PropertyAccessor]()
            for accessor in declared {
                var kind Cs2Gs.CodeModel.Ast.AccessorKind
                if accessor.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration) {
                    kind = Cs2Gs.CodeModel.Ast.AccessorKind.Get
                } else if accessor.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.InitAccessorDeclaration) {
                    // Issue #946: G# now supports a first-class 'init' accessor.
                    kind = Cs2Gs.CodeModel.Ast.AccessorKind.Init
                } else {
                    kind = Cs2Gs.CodeModel.Ast.AccessorKind.Set
                }
                let accessorSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(accessor) as IMethodSymbol
                let visibility = if accessor.Modifiers.Count > 0 {
                    MapVisibility(accessorSymbol, this.context, accessor)
                } else {
                    Visibility.Default
                }
                let bodied = accessor.Body != nil || accessor.ExpressionBody != nil
                var body BlockStatement? = if bodied {
                    this.TranslateBody(accessor, "$displayName ${kind.ToString().ToLowerInvariant()}ter")
                } else {
                    default(BlockStatement?)
                }
                // Issue #1907: a bodyless (auto) accessor sibling to a `field`-
                // keyword accessor on the same property (e.g. `set;` beside
                // `get => field ??= ...;`) implicitly reads/writes that SAME
                // compiler-synthesized backing field — synthesize the equivalent
                // explicit body against the field just registered for this
                // property (ADR-0051 §2 computed-property shape).
                if !bodied && fieldKeywordBackingName != nil {
                    body = if kind == Cs2Gs.CodeModel.Ast.AccessorKind.Get {
                        BlockStatement(List[GStatement]{ReturnStatement(IdentifierExpression(fieldKeywordBackingName))})
                    } else {
                        BlockStatement(
                            List[GStatement]{
                                AssignmentStatement(
                                    IdentifierExpression(fieldKeywordBackingName),
                                    IdentifierExpression("value")
                                )
                            }
                        )
                    }
                }
                // Issue #1278 / ADR-0131: a C# expression-bodied accessor
                // (`get => e` / `set => e`) renders as the idiomatic G# arrow
                // accessor `get -> e` / `set -> e` when its body folds to a
                // single inline statement.
                let arrowBody GStatement? = if accessor.ExpressionBody != nil {
                    TryFoldArrowBody(body)
                } else {
                    default(GStatement?)
                }
                if arrowBody != nil {
                    body = nil
                }
                accessors.Add(PropertyAccessor(kind, body, expressionBody: arrowBody, visibility: visibility))
            }
            return accessors
        }

        private func TranslateConstructor(
            node Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax,
            propertyCtorInits IReadOnlyList[(Name string?, Value GExpression?)]?
        ) GMember? {
            let symbol IMethodSymbol? = this.context.GetDeclaredSymbol(node) as IMethodSymbol
            if node.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) {
                // A `static` constructor has no G# form. When it only initializes
                // static fields with simple `Field = value;` assignments, those are
                // folded into the corresponding `shared { }` field initializers
                // (see CollectStaticFieldInitializers / TranslateField) and the
                // constructor is dropped. Anything more complex is unsupported.
                if this.IsFoldableStaticConstructor(node, symbol?.ContainingType) {
                    return nil
                }
                // ADR-0140 / ADR-0115 §B.11: a non-foldable static constructor
                // maps to a G# `init { ... }` static-initializer block inside the
                // type's `shared { }` block. Simple static-field initializers are
                // hoisted onto their field declarations separately (see
                // CollectStaticFieldInitializers); the remaining ctor body is
                // translated as-is here.
                let staticInitBody = this.TranslateBody(node, "static initializer")
                return StaticInitializerBlock(staticInitBody)
            }
            let parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false)
            var baseArguments List[GExpression]? = nil
            var delegatingArguments List[GExpression]? = nil
            // Issue #4422: a `ref x!` in the initializer collects its GS0612
            // suppression here, not into the member-level set.
            let outerSuppressions HashSet[string]? = this.state.PendingStatementSuppressions
            let initializerSuppressions = HashSet[string](StringComparer.Ordinal)
            this.state.PendingStatementSuppressions = initializerSuppressions
            if node.Initializer != nil {
                if node.Initializer!!.ThisOrBaseKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.BaseKeyword) {
                    // A `: base(args)` chain maps to the canonical G# explicit-base
                    // form `init(params) : base(args) { ... }` (sample
                    // ExplicitConstructor.gs; ADR-0115 §B.13). This is how a custom
                    // exception forwards its message to System.Exception's ctor.
                    baseArguments = this.TranslateConstructorInitializerArguments(node.Initializer)
                } else {
                    // `: this(args)` (constructor delegation) maps to a G#
                    // `convenience init(params) { init(args); ... }`: the delegated
                    // arguments are retained on the constructor model so its
                    // canonical lowering always emits `init(args)` first.
                    delegatingArguments = this.TranslateConstructorInitializerArguments(node.Initializer)
                }
            }
            this.state.PendingStatementSuppressions = outerSuppressions
            var body = this.TranslateBody(node, "constructor on '${node.Identifier.Text}'")
            if delegatingArguments == nil && propertyCtorInits != nil && propertyCtorInits.Count > 0 {
                // OD-T1: move get-only auto-property inline initializers into the
                // designated constructor body (G# has no property member
                // initializer). Prepend them so the property is initialized before
                // the original constructor body runs, matching C# member-initializer
                // ordering. Delegating (`: this(...)`) constructors are skipped — the
                // designated target already runs the initializers.
                let statements = propertyCtorInits.Select(
                    (p(Name string, Value GExpression)) -> cast[GStatement](
                        AssignmentStatement(IdentifierExpression(p.Name), p.Value)
                    )
                )
                    .ToList()
                statements.AddRange(body.Statements)
                body = BlockStatement(statements)
            }
            let constructorDeclaration = ConstructorDeclaration(
                parameters,
                body,
                baseArguments: baseArguments,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists),
                delegatingArguments: delegatingArguments
            )
            // A `: this(...)` delegation prints as the body's first statement,
            // `init(args)`, so its suppression wraps just that call. A
            // `: base(...)` chain stays in the header, where no block fits and
            // an annotation on the constructor would widen over its body: it
            // is left unsuppressed.
            if delegatingArguments != nil && initializerSuppressions.Count > 0 {
                constructorDeclaration.DelegatingSuppressedDiagnostics = initializerSuppressions.OrderBy(
                    (id string) -> id,
                    StringComparer.Ordinal
                )
                    .ToList()
            }
            return constructorDeclaration
        }

        private func TranslateConstructorInitializerArguments(initializer ConstructorInitializerSyntax?) List[
            GExpression
        ] {
            let arguments = initializer!!.ArgumentList.Arguments
            if this
                .context
                .GetSymbolInfo(initializer)
                .Symbol is not IMethodSymbol constructor ||
                arguments.Count > constructor
                .Parameters
                .Length {
                this.context.ReportUnsupported(
                    initializer,
                    "named constructor-initializer arguments could not be mapped to positional parameter order."
                )
                return this.TranslateNullSeamArguments(arguments)
            }
            let hasNamedArguments = arguments.Any((argument ArgumentSyntax) -> argument.NameColon != nil)
            if !hasNamedArguments && arguments.Count == constructor.Parameters.Length {
                return this.TranslateNullSeamArguments(arguments)
            }
            let explicitArguments = Dictionary[int32, ArgumentSyntax]()
            var lastOrdinal = -1
            var reordersArguments = false
            for var i = 0; i < arguments.Count; i++ {
                let argument = arguments[i]
                let parameter IParameterSymbol? = if argument.NameColon == nil {
                    constructor.Parameters[i]
                } else {
                    constructor.Parameters.FirstOrDefault(
                        (candidate IParameterSymbol) -> candidate.Name == argument.NameColon!!.Name.Identifier.ValueText
                    )
                }
                if parameter == nil || !explicitArguments.TryAdd(parameter.Ordinal, argument) {
                    this.context.ReportUnsupported(
                        initializer,
                        "named constructor-initializer arguments could not be mapped uniquely to parameters."
                    )
                    return this.TranslateNullSeamArguments(arguments)
                }
                reordersArguments |= parameter.Ordinal <= lastOrdinal
                lastOrdinal = parameter.Ordinal
            }
            if hasNamedArguments && reordersArguments && arguments.Any(
                (argument ArgumentSyntax) -> !IsTrivialConstructorInitializerArgument(argument.Expression)
            ) {
                this.context.ReportUnsupported(
                    initializer,
                    "named constructor-initializer arguments reorder side-effecting expressions; no faithful positional G# lowering is available."
                )
                return this.TranslateNullSeamArguments(arguments)
            }
            let translated = List[GExpression](constructor.Parameters.Length)
            for var ordinal = 0; ordinal < constructor.Parameters.Length; ordinal++ {
                if explicitArguments.TryGetValue(ordinal, out var argument) {
                    translated.Add(this.TranslateNullSeamArgument(argument, preserveName: false))
                    continue
                }
                let parameter = constructor.Parameters[ordinal]
                if !parameter.HasExplicitDefaultValue {
                    this.context.ReportUnsupported(
                        initializer,
                        "named constructor-initializer argument skips required parameter '${parameter.Name}'."
                    )
                    return this.TranslateNullSeamArguments(arguments)
                }
                var defaultValue GExpression? = this.MapConstantDefault(parameter, initializer)
                if defaultValue == nil {
                    defaultValue = if parameter.Type.IsValueType {
                        cast[GExpression](
                            DefaultValueExpression(
                                this.typeMapper.Map(parameter.Type, this.context, initializer!!.GetLocation())
                            )
                        )
                    } else {
                        cast[GExpression](LiteralExpression.Null())
                    }
                }
                translated.Add(defaultValue!!)
            }
            return translated
        }

        /// Collects the static-field initializers of a foldable `static`
        /// constructor so they can be re-attached to the corresponding fields
        /// (G# has no static-constructor form; ADR-0115 §B.11).
        private func CollectStaticFieldInitializers(
            members IReadOnlyList[MemberDeclarationSyntax],
            typeSymbol INamedTypeSymbol?
        ) {
            for member in members {
                if member is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConstructorDeclarationSyntax ctor ||
                    !ctor
                    .Modifiers
                    .Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword) || ctor.Body == nil {
                    continue
                }
                // Issue #1910: a merged-in static constructor from another
                // partial part/file lives in a different `SyntaxTree`.
                using let modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree)
                if !this.IsFoldableStaticConstructor(ctor, typeSymbol) {
                    continue
                }
                for statement in ctor.Body!!.Statements {
                    if statement is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .ExpressionStatementSyntax expressionStatement &&
                        expressionStatement.Expression is Microsoft
                        .CodeAnalysis
                        .CSharp
                        .Syntax
                        .AssignmentExpressionSyntax assignment &&
                        assignment.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) &&
                        this
                        .context
                        .GetSymbolInfo(assignment.Left)
                        .Symbol is IFieldSymbol field {
                        this.state.StaticFieldInitializers[field] = this.TranslateExpression(assignment.Right)!!
                    }
                }
            }
        }

        /// Issue #1729: a static constructor folds cleanly only when every
        /// statement is a simple `Field = expr;` assignment where (mode 2)
        /// the assigned field belongs to the type declaring the constructor — an
        /// assignment to another type's static field would be silently dropped,
        /// since the folded entry is keyed by that other field and never consumed
        /// — and (mode 3) the RHS does not depend on the type's own static state,
        /// since hoisting it to the field's declaration position could change
        /// C#'s field-initializers-then-cctor evaluation order. Anything else is
        /// reported as unsupported instead of silently folded.
        private func IsFoldableStaticConstructor(
            node Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax,
            typeSymbol INamedTypeSymbol?
        ) bool {
            if node.Body == nil {
                return node.ExpressionBody == nil
            }
            if typeSymbol == nil {
                return false
            }
            for statement in node.Body!!.Statements {
                if statement is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ExpressionStatementSyntax expressionStatement ||
                    expressionStatement.Expression is not Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .AssignmentExpressionSyntax assignment ||
                    !assignment.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SimpleAssignmentExpression) ||
                    this
                    .context
                    .GetSymbolInfo(assignment.Left)
                    .Symbol is not IFieldSymbol{IsStatic: true} field ||
                    !SymbolEqualityComparer
                    .Default
                    .Equals(field.ContainingType, typeSymbol) || this.ReferencesStaticMemberOfType(
                    assignment.Right,
                    typeSymbol
                ) {
                    return false
                }
            }
            return true
        }

        private func MapBaseClause(
            symbol INamedTypeSymbol?,
            node Microsoft.CodeAnalysis.SyntaxNode,
            kind TypeDeclarationKind
        )(BaseType GTypeReference?, Interfaces List[GTypeReference]) {
            let interfaces = List[GTypeReference]()
            var baseType GTypeReference? = nil
            if symbol == nil {
                return (nil, interfaces)
            }
            let location = node.GetLocation()
            let csBase INamedTypeSymbol? = symbol.BaseType
            if csBase != nil &&
                csBase.SpecialType != SpecialType.System_Object &&
                csBase.SpecialType != SpecialType.System_ValueType &&
                csBase.TypeKind == TypeKind.Class &&
                csBase.SpecialType != SpecialType.System_Enum {
                baseType = this.typeMapper.Map(csBase, this.context, location)
            }
            for iface in symbol.Interfaces {
                // Interface inheritance is supported by the G# parser since
                // issue #1006 (`interface B : A, C { ... }`); the printer emits
                // base interfaces via the same base-clause path as a class, so
                // a base interface is added to the interface's base list.
                interfaces.Add(this.typeMapper.Map(iface, this.context, location)!!)
            }
            return (baseType, interfaces)
        }

        /// Issue #1909: maps a C# `: Base(args)` base-class initializer
        /// (Roslyn's (cref:PrimaryConstructorBaseTypeSyntax) — the only base-list
        /// entry kind that carries an argument list; an implemented interface is
        /// always a plain (cref:SimpleBaseTypeSyntax)) onto the G# primary
        /// constructor's own base-call syntax `class Derived(...) : Base(args)`
        /// (Parser.cs `baseCtorOpenParen` / `BaseConstructorArguments`). Returns
        /// `null` when the base clause has no explicit call — the
        /// G# emitter then synthesizes the implicit parameterless base chain
        /// (ADR-0065 §5), matching a C# base with no arguments (or no base at all).
        private func MapPrimaryConstructorBaseArguments(node TypeDeclarationSyntax, baseType GTypeReference?) List[
            GExpression
        ]? {
            if baseType == nil || node.BaseList == nil {
                return nil
            }
            for baseTypeSyntax in node.BaseList!!.Types {
                if baseTypeSyntax is PrimaryConstructorBaseTypeSyntax primaryBase {
                    return primaryBase.ArgumentList.Arguments.Select(this.TranslateArgument).ToList()
                }
            }
            return nil
        }

        private func MapTypeParameters(symbol INamedTypeSymbol?) List[TypeParameter] {
            if symbol == nil || symbol.TypeParameters.Length == 0 {
                return List[TypeParameter]()
            }
            return symbol.TypeParameters.Select(this.MapTypeParameter).ToList()
        }

        // ADR-0192: an emitted declaring part maps the implementation's type
        // parameters (its facts) but spells their constraints at the
        // definition's locations (`spellingSymbol`), so the constraint types
        // resolve in the definition file's scope — as MapParameter's
        // `spellingLocation` does for parameter types.
        private func MapMethodTypeParameters(symbol IMethodSymbol?, spellingSymbol IMethodSymbol? = nil) List[
            TypeParameter
        ] {
            if symbol == nil || symbol.TypeParameters.Length == 0 {
                return List[TypeParameter]()
            }
            return symbol
                .TypeParameters
                .Select(
                (tp ITypeParameterSymbol, index int32) -> this.MapTypeParameter(
                    tp,
                    spellingSymbol?.TypeParameters[index].Locations.FirstOrDefault()
                )
            )
                .ToList()
        }

        private func MapTypeParameter(tp ITypeParameterSymbol) TypeParameter {
            return this.MapTypeParameter(tp, spellingLocation: nil)
        }

        private func MapTypeParameter(tp ITypeParameterSymbol, spellingLocation Location?) TypeParameter {
            var spellingLocation = spellingLocation
            spellingLocation ??= tp.Locations.FirstOrDefault()
            let flags = List[string]()
            if tp.HasReferenceTypeConstraint {
                flags.Add("class")
            }
            if tp.HasUnmanagedTypeConstraint {
                // Issue #1336: C# `where T : unmanaged` maps to the G# `unmanaged`
                // flag constraint. It subsumes `struct` (gsc reports a conflict if
                // both are spelled), so the value-type flag is intentionally omitted.
                flags.Add("unmanaged")
            } else if tp.HasValueTypeConstraint {
                flags.Add("struct")
            }
            if tp.HasConstructorConstraint {
                flags.Add("init()")
            }
            // C# `where T : notnull` has no precise G# constraint keyword; it is
            // dropped (the closest forms `comparable`/`any` change semantics), and
            // the loss is recorded (ADR-0115 §B.7 gap).
            if tp.HasNotNullConstraint {
                this.context.Report(
                    TranslationDiagnostic(
                        "TypeParameterConstraintClause",
                        "type parameter '${tp.Name}' has a 'notnull' constraint; G# has no equivalent constraint keyword, so it is dropped (ADR-0115 §B.7 gap).",
                        spellingLocation,
                        TranslationSeverity.Info
                    )
                )
            }
            var legacy string? = nil
            if tp.ConstraintTypes.Length > 0 {
                let primary = tp.ConstraintTypes[0]
                // Issues #943 and #2509: every selected class/interface
                // constraint uses the canonical semantic type mapper. The old
                // non-generic branch emitted only `primary.Name`, discarding
                // namespace/nesting identity and allowing a synthesized import
                // containing a homonym to rebind the constraint.
                let constraintRef = this.typeMapper.MapConstraintType(primary, this.context, spellingLocation)
                legacy = GSharpPrinter.RenderTypeReference(constraintRef)
                if tp.ConstraintTypes.Length > 1 {
                    this.context.Report(
                        TranslationDiagnostic(
                            "TypeParameterConstraintClause",
                            "type parameter '${tp.Name}' has multiple constraint types; only the first ('$legacy') is carried into the G# legacy-constraint slot (ADR-0115 §B.7).",
                            spellingLocation,
                            TranslationSeverity.Info
                        )
                    )
                }
            }
            let variance = switch tp.Variance {
                case VarianceKind.Out: Variance.Out
                case VarianceKind.In: Variance.In
                default: Variance.None
            }
            return TypeParameter(this.EmittedName(tp, tp.Name), legacy, flags, variance)
        }

        // Issue #1909: `TypeDeclarationSyntax.ParameterList` carries a primary
        // constructor's parameter list for EVERY declaration kind that supports one
        // — `record`/`record struct` (their positional parameter list, in C# 9+)
        // as well as a plain `class`/`struct` (C# 12 primary constructors). All map
        // the same way onto a G# primary constructor (ADR-0065 §5), so the check no
        // longer needs to special-case `RecordDeclarationSyntax`.
        private func MapPrimaryConstructor(node TypeDeclarationSyntax) IReadOnlyList[Parameter]? {
            if node.ParameterList != nil {
                return this.MapParameterList(node.ParameterList)
            }
            return nil
        }

        private func MapParameters(symbol IMethodSymbol?, syntax ParameterListSyntax?, skipFirst bool) List[Parameter] {
            if symbol != nil {
                var source IEnumerable[IParameterSymbol] = symbol.Parameters
                if skipFirst {
                    source = source.Skip(1)
                }
                // Fall back to the parameter LIST's syntax as the diagnostic anchor
                // for each parameter symbol here: when `symbol` overrides/implements
                // a member from a REFERENCED assembly, its `IParameterSymbol`s have
                // no `DeclaringSyntaxReferences` of their own (see
                // <see cref="MapConstantDefault"/> remarks).
                return source.Select((p IParameterSymbol) -> this.MapParameter(p, syntax)).ToList()
            }
            return if syntax == nil {
                List[Parameter]()
            } else {
                this.MapParameterList(syntax)
            }
        }

        private func MapParameterList(syntax BaseParameterListSyntax?, promoteNullability bool = true) List[Parameter] {
            let parameters = List[Parameter]()
            for parameter in syntax!!.Parameters {
                if this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol {
                    parameters.Add(this.MapParameter(symbol, parameter, promoteNullability))
                }
            }
            return parameters
        }

        private func MapParameter(
            symbol IParameterSymbol,
            fallbackNode Microsoft.CodeAnalysis.SyntaxNode?,
            promoteNullability bool = true,
            spellingLocation Location? = nil
        ) Parameter {
            var spellingLocation = spellingLocation
            // ADR-0192: a partial method's declaring part maps the
            // implementation's parameter symbols but must spell their types in
            // the DEFINITION's file, so the caller passes the definition
            // parameter's location to spell at.
            spellingLocation ??= symbol.Locations.FirstOrDefault()
            let refKind string? = switch symbol.RefKind {
                case RefKind.Ref: "ref"
                case RefKind.Out: "out"
                case RefKind.In: "in"
                default: default(string?)
            }
            // gsc's own variadic parameter (`...T`, DeclarationBinder.cs) is always
            // an array/slice — it has no params-COLLECTION concept (C#13). A C#
            // `params List<int>`/`params IEnumerable<T>` parameter therefore maps
            // to an ordinary (non-variadic) G# parameter of the FULL collection
            // type; `variadic` here is only ever true for the genuine `params T[]`
            // shape, which gsc's variadic slice already models 1:1. The
            // corresponding expanded call site (`Total(1, 2, 3)`) is lowered at the
            // CALL, not the declaration — see <see cref="TranslateParamsCollectionArguments"/>.
            // ADR-0173 / issue #3627: gsc now supports generalized variadic
            // carriers (`...X[T]` ≡ C#13 `params X<T>`). An array params maps
            // to the classic `...T` element spelling; a supported collection
            // params (List, the IEnumerable family, Span/ReadOnlySpan) keeps
            // its CARRIER type after the ellipsis (`...List[int32]`). Only
            // unsupported collection shapes (e.g. HashSet<T>) still gap.
            let variadic = symbol.IsParams &&
                (symbol.Type is IArrayTypeSymbol || IsSupportedParamsCollectionType(symbol.Type))
            var parameterType = symbol.Type
            let variadicElementType ITypeSymbol? = if variadic && symbol.Type is IArrayTypeSymbol paramsArray {
                paramsArray.ElementType
            } else {
                default(ITypeSymbol?)
            }
            var variadicElementNestedInArrayType = false
            if variadic &&
                parameterType is IArrayTypeSymbol arrayType &&
                !(arrayType.ElementType is IArrayTypeSymbol) &&
                !IsSupportedParamsCollectionType(arrayType.ElementType) {
                parameterType = arrayType.ElementType
            } else if variadicElementType != nil {
                variadicElementNestedInArrayType = true
            }
            // An array params whose ELEMENT is itself carrier-shaped (e.g.
            // `params List<int>[]`, `params byte[][]`) keeps the explicit
            // array spelling (`...[]List[int32]`, `...[][]uint8`) — the bare
            // element spelling would reinterpret as a carrier under ADR-0173.
            if symbol.IsParams && !variadic {
                this.context.ReportUnsupported(
                    fallbackNode,
                    "params collection of type '$parameterType' has no gsc construction form."
                )
            }
            // Issue #4127/#4129 (self-hosting regression, #3501): decomposed —
            // not a nested `{ TypeKind: TypeKind.Delegate, DelegateInvokeMethod:
            // not null }` pattern — because gsc's pattern matcher does not
            // reliably evaluate a property pattern containing an
            // enum-constant sub-pattern against an imported-interface-typed
            // scrutinee (`parameterType` is declared `ITypeSymbol`) once this
            // exact source is itself translated to G# and compiled by gsc.
            // See CSharpTypeMapper.MapEventType for the full explanation and
            // for why the null-check sub-pattern here is incidental, not
            // part of the trigger — #4153's own repro reproduces on the enum
            // sub-pattern alone. This is the constructor-parameter call site
            // that silently lost a C# `Predicate<int32>`'s nominal identity
            // under self-hosting because this condition always evaluated to
            // false.
            let explicitlyNamedDelegate = parameterType is INamedTypeSymbol namedParameterType &&
                namedParameterType.TypeKind == TypeKind.Delegate &&
                namedParameterType.DelegateInvokeMethod != nil &&
                symbol
                .DeclaringSyntaxReferences
                .Any(
                (reference SyntaxReference) -> (
                    reference.GetSyntax() is Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax and {Type: not nil}
                )
            )
            var type GTypeReference? = if explicitlyNamedDelegate {
                this.typeMapper.MapExplicitType(parameterType, this.context, spellingLocation)
            } else {
                this.typeMapper.Map(parameterType, this.context, spellingLocation)
            }
            // Issue #1072/#3888: promote the declaration position that actually
            // receives null. Ordinary parameters use their carrier symbol; a
            // variadic array uses the separately tracked expanded-ELEMENT
            // evidence, never nullable evidence about the array itself.
            if promoteNullability && variadicElementType != nil {
                type = this.PromoteParamsElementIfUsedAsNullable(
                    type,
                    symbol,
                    variadicElementType,
                    variadicElementNestedInArrayType
                )
            } else if !variadic && promoteNullability {
                type = this.PromoteIfUsedAsNullable(type, symbol)
            }
            if variadic {
                type = this.PromoteObliviousParamsElement(type, parameterType, symbol)
            }
            // Issue #914 (oblivious sink): a DELEGATE-typed parameter that is
            // invoked inside its method with a null (or promoted-nullable)
            // argument at some position must render that arrow-parameter position
            // as `T?` — e.g. `SendOrPost(Action<SendOrPostCallback, object>
            // sendOrPost, …)` whose body does `sendOrPost(o => …, null)` needs the
            // second arrow parameter to be `object?`, otherwise the `nil -> object`
            // call argument is rejected (GS0155). The delegate's own invoke
            // signature carries no nullability in oblivious metadata, so the
            // evidence is the null argument flowing to it at the call site.
            if !variadic {
                type = this.PromoteDelegateParameterInvokedWithNull(type, symbol)
            }
            let defaultValue GExpression? = this.BuildOptionalParameterDefault(symbol, type, fallbackNode)
            return Parameter(
                MapParameterName(symbol, fallbackNode),
                type,
                variadic,
                refKind,
                defaultValue,
                this.MapParameterAttributes(symbol)
            )
        }

        private func MapParameterAttributes(symbol IParameterSymbol) List[AttributeUse]? {
            // Issue #1913: a parameter's own attributes (e.g. `[Note] int x`) live on
            // its `ParameterSyntax`, not on `fallbackNode` (which can be the whole
            // parameter LIST when `symbol` came from `MapParameters`). Resolve the
            // parameter's declaring syntax directly from the symbol so both call
            // paths route through the same `MapAttributes` helper every other
            // declaration kind already uses — otherwise the attribute is silently
            // dropped with no diagnostic.
            let parameterSyntax Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParameterSyntax? = symbol
                .DeclaringSyntaxReferences
                .Select((syntaxReference SyntaxReference) -> syntaxReference.GetSyntax())
                .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]()
                .FirstOrDefault()
            // Issue #4370: gsc takes a [LibraryImport] string's encoding from
            // the import's StringMarshalling (a string @MarshalAs is GS0360);
            // MapLibraryImportMethodAttributes folds it in there.
            let isLibraryImportString = symbol
                .Type
                .SpecialType == SpecialType.System_String &&
                symbol.ContainingSymbol is IMethodSymbol importMethod &&
                CSharpToGSharpTranslator.IsLibraryImportDefinition(importMethod)
            var attributes List[AttributeUse]? = if parameterSyntax == nil {
                default(List[AttributeUse]?)
            } else {
                (
                    if isLibraryImportString {
                        this.MapAttributesWithoutMarshalAs(parameterSyntax.AttributeLists)
                    } else {
                        this.MapAttributes(parameterSyntax.AttributeLists)
                    }
                )
            }
            // C# emits no FieldMarshal row for the default P/Invoke bool
            // contract, but the CLR marshaler still treats bool as a four-byte
            // Win32 BOOL. G# intentionally requires that ABI to be explicit for
            // byref bool, so materialize C#'s effective default during migration.
            if symbol.RefKind != RefKind.None &&
                symbol
                .Type
                .SpecialType == SpecialType.System_Boolean &&
                symbol.ContainingSymbol is IMethodSymbol method &&
                method.GetDllImportData() != nil && !symbol.GetAttributes().Any(
                (attribute AttributeData) -> attribute
                    .AttributeClass
                    ?.ToDisplayString() == "System.Runtime.InteropServices.MarshalAsAttribute"
            ) {
                attributes ??= List[AttributeUse]()
                attributes!!.Add(
                    AttributeUse(
                        "System.Runtime.InteropServices.MarshalAs",
                        []AttributeArgument{
                            AttributeArgument(
                                MemberAccessExpression(
                                    IdentifierExpression("System.Runtime.InteropServices.UnmanagedType"),
                                    "Bool"
                                )
                            )
                        }
                    )
                )
            }
            return attributes
        }

        private func MapParameterName(
            symbol IParameterSymbol,
            fallbackNode Microsoft.CodeAnalysis.SyntaxNode?
        ) string? {
            let underscoreParameter Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParameterSyntax? = fallbackNode as Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParameterSyntax ??
                symbol
                .DeclaringSyntaxReferences
                .FirstOrDefault()
                ?.GetSyntax() as Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParameterSyntax
            if symbol.Name != "_" || underscoreParameter == nil {
                return this.EmittedName(symbol, symbol.Name)
            }
            // Issue #3467: gsc accepts `_` as a (repeatable) discard parameter
            // name, so an unreferenced C# `_` parameter keeps its spelling. A
            // single `_` parameter that the body actually READS (legal C#: `_`
            // is only a discard when it cannot bind) still needs a real
            // identifier, since G# `_` is a true blank; only that case renames
            // to `__underscore` (paired with the identifier-reference rewrite
            // in TranslateIdentifierName).
            let underscoreCount = if underscoreParameter.Parent is ParameterListSyntax parameterList {
                parameterList.Parameters.Count(
                    (p Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax) -> p.Identifier.ValueText == "_"
                )
            } else {
                1
            }
            if underscoreCount > 1 {
                return "_"
            }
            let body Microsoft.CodeAnalysis.SyntaxNode? = underscoreParameter.Ancestors().FirstOrDefault(
                (ancestor Microsoft.CodeAnalysis.SyntaxNode) -> ancestor is AnonymousFunctionExpressionSyntax ||
                    ancestor is LocalFunctionStatementSyntax ||
                    ancestor is BaseMethodDeclarationSyntax
            )
            let model = if body == nil {
                this.context.SemanticModel
            } else {
                this.context.Compilation.GetSemanticModel(body.SyntaxTree)
            }
            let referenced = body != nil &&
                body
                .DescendantNodes()
                .OfType[IdentifierNameSyntax]()
                .Any(
                (identifier IdentifierNameSyntax) -> identifier
                    .Identifier
                    .ValueText == "_" &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(model.GetSymbolInfo(identifier).Symbol, symbol)
            )
            return if referenced {
                "__underscore"
            } else {
                "_"
            }
        }

        /// Computes the G# default-value expression for an optional C# parameter,
        /// or `null` when the parameter is required or its default cannot be
        /// represented as a simple literal. An optional parameter whose default is
        /// the zero value (`= default`, `= default(T)`, or `= null`)
        /// must never be dropped — doing so makes the parameter required and triggers
        /// GS0144 at call sites. A non-nullable value type emits `default(T)`
        /// (gsc rejects a bare `default` with GS0265); a reference or nullable
        /// value type emits `nil`.
        /// @remarks Issue #1731 N1: a C# optional-parameter default must itself be a
        /// compile-time constant, so this method (and (cref:MapConstantDefault))
        /// only ever reads `symbol.ExplicitDefaultValue` — it never calls
        /// `TranslateExpression`/`TranslatePatternTest`/
        /// `TranslateRangeSlice` on the source syntax at all. A non-constant
        /// default (which could theoretically embed an `is`-pattern or a
        /// range-slice, except neither of those is itself a constant expression
        /// either) falls through to the "not a simple literal" diagnostic below
        /// and is omitted, never translated. So `SpillOperand`'s no-seam
        /// fallback can never be reached from here.
        private func BuildOptionalParameterDefault(
            symbol IParameterSymbol,
            type GTypeReference?,
            fallbackNode Microsoft.CodeAnalysis.SyntaxNode?,
            spellingNode Microsoft.CodeAnalysis.SyntaxNode? = nil
        ) GExpression? {
            if !symbol.HasExplicitDefaultValue {
                return nil
            }
            let defaultValue GExpression? = this.MapConstantDefault(symbol, fallbackNode, spellingNode)
            if defaultValue != nil {
                return defaultValue
            }
            if symbol.ExplicitDefaultValue == nil {
                let nullableValueType = symbol.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T
                let nonNullableValueType = symbol
                    .Type
                    .IsValueType &&
                    !nullableValueType &&
                    symbol
                    .Type
                    .NullableAnnotation != Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .Annotated
                return if nonNullableValueType {
                    cast[GExpression](DefaultValueExpression(type))
                } else {
                    cast[GExpression](IdentifierExpression("nil"))
                }
            }
            this.context.Report(
                TranslationDiagnostic(
                    "EqualsValueClause",
                    "parameter '${symbol.Name}' has a default value that is not a simple literal; the default is omitted for now (deferred to step 7).",
                    spellingNode?.GetLocation() ?? symbol.Locations.FirstOrDefault(),
                    TranslationSeverity.Info
                )
            )
            return nil
        }

        private func MapReturnType(
            symbol IMethodSymbol?,
            node MethodDeclarationSyntax,
            unwrapValueTask bool = false,
            iteratorBodySource MethodDeclarationSyntax? = nil,
            preserveEnvelope bool = false
        ) GTypeReference? {
            var iteratorBodySource = iteratorBodySource
            // ADR-0192: a partial method's declaring part spells its return
            // type at the definition (`node`) but takes the iterator fact from
            // the implementation's body.
            iteratorBodySource ??= node
            if symbol != nil {
                if symbol.ReturnsVoid {
                    return if symbol.IsAsync && !preserveEnvelope {
                        NamedTypeReference("void")
                    } else {
                        default(NamedTypeReference?)
                    }
                }
                let returnType = symbol.ReturnType
                // An iterator `func` (its body contains a `yield`) that DECLARES a
                // C# `IEnumerable[T]` envelope maps to the G# `sequence[T]` element
                // type, not the envelope itself (spec §Iterators; sample
                // TupleSequenceIterators.gs). The element type is the single type
                // argument of the C# IEnumerable<T> return.
                //
                // An iterator whose declared return type is `IEnumerator[T]` is the
                // class-level `GetEnumerator()` member of an `IEnumerable[T]`
                // implementation: it must keep the `IEnumerator[T]` return type so it
                // satisfies `IEnumerable[T].GetEnumerator` and forms the dual
                // GetEnumerator bridge pair with the non-generic
                // `func GetEnumerator() IEnumerator` (issue #985). A G# generator may
                // return `IEnumerator[T]`, so the `yield` body is unaffected — only
                // `IEnumerable[T]` returns are rewritten to `sequence[T]`.
                if IsIteratorBody(iteratorBodySource) &&
                    returnType is INamedTypeSymbol{IsGenericType: true} enumerable &&
                    enumerable.Name == "IEnumerable" {
                    if preserveEnvelope {
                        // A direct companion keeps the CLR envelope and the
                        // hosted iterator's existing element-position promotion.
                        let envelope GTypeReference? = this.typeMapper.Map(
                            returnType,
                            this.context,
                            node.ReturnType.GetLocation()
                        )
                        return this.PromoteTaskEnvelopeReturnIfTainted(envelope, enumerable.TypeArguments[0], symbol)
                    }
                    var element GTypeReference? = this.typeMapper.Map(
                        enumerable.TypeArguments[0],
                        this.context,
                        node.ReturnType.GetLocation()
                    )
                    // Issue #3501: the iterator ELEMENT is the method's return
                    // sink for T exactly like the async `Task<T>` unwrap below
                    // (#2421) — a tainted iterator (yielding promoted-nullable
                    // values) must render `sequence[T?]`, or the signature
                    // disagrees with its own yields (GS0155 `string?` →
                    // `string`) while the yield-seam bridge correctly stands
                    // down because the return IS promoted.
                    let elementType = enumerable.TypeArguments[0]
                    element = this.PromoteTupleDeclarationIfTainted(element, elementType, symbol)
                    element = this.PromoteAwaitedReturnIfTainted(element, elementType, symbol)
                    return NamedTypeReference("sequence", []GTypeReference{element!!})
                }
                // A G# `async func` declares the UNWRAPPED result type; the `async`
                // modifier synthesizes the `Task`/`Task<T>` envelope (samples
                // AsyncTask.gs, AsyncValueReturns.gs). C# `async Task` → no return
                // type; `async Task<int>` → `int32` (ADR-0115 §B async).
                //
                // ADR-0174 D4: a `suspend func` declares its logical result the
                // same way, so a suspending candidate's `ValueTask`/`ValueTask<T>`
                // is unwrapped too (unwrapValueTask); any other ValueTask method
                // keeps the explicit envelope.
                if !preserveEnvelope &&
                    symbol.IsAsync &&
                    returnType is INamedTypeSymbol{Name: "Task" or "ValueTask"} task &&
                    (task.Name == "Task" || unwrapValueTask) &&
                    task
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Threading.Tasks" {
                    if !task.IsGenericType {
                        return nil
                    }
                    // Issue #2421: an `async Task<T>` return is still a
                    // declaration sink for T like any other method return —
                    // the unwrap above must not skip the SAME tuple/scalar
                    // promotion the synchronous path below applies, keyed off
                    // the AWAITED type T (see PromoteAwaitedReturnIfTainted).
                    let awaitedType = task.TypeArguments[0]
                    var awaitedMapped GTypeReference? = this.typeMapper.Map(
                        awaitedType,
                        this.context,
                        node.ReturnType.GetLocation()
                    )
                    awaitedMapped = this.PromoteTupleDeclarationIfTainted(awaitedMapped, awaitedType, symbol)
                    return this.PromoteAwaitedReturnIfTainted(awaitedMapped, awaitedType, symbol)
                }
                // Issue #1900: `symbol.ReturnType` is already the pointee type T
                // for a `ref`-returning method (Roslyn strips the `ref`); the
                // `ref` modifier itself is reinstated at the MethodDeclaration
                // (IsRefReturn) by the caller, mapping to G#'s native
                // ref-return (`func F(...) ref T`, issue #490/ADR-0060).
                var mapped GTypeReference? = this.typeMapper.Map(
                    returnType,
                    this.context,
                    node.ReturnType.GetLocation()
                )
                // Issue #2469: promote tuple return leaves independently from
                // the analyzer's element-path evidence graph. Applied before
                // scalar promotion, which is a no-op for tuple value types.
                mapped = this.PromoteTupleDeclarationIfTainted(mapped, returnType, symbol)
                // Issue #2423: a NON-async declaration (a C# interface member —
                // interfaces cannot declare `async` members — or a synchronous
                // method that literally returns a `Task<T>`/`ValueTask<T>`
                // envelope) is still a taint-consumption sink for the AWAITED
                // type T, not for the envelope itself: the Task instance is not
                // a nullability-bearing artifact of the source, only the
                // logical awaited result is. Whole-envelope promotion here
                // (`Task[T]?`) would render a structurally different shape
                // from an `async` implementation's sugar, which instead
                // nullifies the awaited result (`Task[T?]`,
                // PromoteAwaitedReturnIfTainted) — defeating interface/impl
                // conformance once CollectInterfaceMethodEdges syncs both
                // sides' taint (GS0187).
                if returnType is INamedTypeSymbol{IsGenericType: true} taskLikeSync &&
                    taskLikeSync
                    .TypeArguments
                    .Length == 1 &&
                    taskLikeSync
                    .ContainingNamespace
                    ?.ToDisplayString() == "System.Threading.Tasks" && (taskLikeSync.Name is "Task" or "ValueTask") {
                    return this.PromoteTaskEnvelopeReturnIfTainted(mapped, taskLikeSync.TypeArguments[0], symbol)
                }
                // Issue #2113: promote the return type to `T?` through the same
                // shared symbol-position decision used by every declaration sink.
                return this.PromoteReturnIfTainted(mapped, symbol)
            }
            return if node.ReturnType is PredefinedTypeSyntax predefined && predefined.Keyword.IsKind(
                Microsoft.CodeAnalysis.CSharp.SyntaxKind.VoidKeyword
            ) {
                default(NamedTypeReference?)
            } else {
                NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType)
            }
        }

        private func MapAttributes(
            attributeLists IEnumerable[AttributeListSyntax],
            isSuspendingDeclaration bool = false
        ) List[AttributeUse] {
            let attributes = List[AttributeUse]()
            for list in attributeLists {
                let target string? = list.Target?.Identifier.Text
                for attribute in list.Attributes {
                    // An owner-scoped extension's forwarding companion leaves off the attributes
                    // that name one of the owner's private nested types (see
                    // TranslateOwnerScopedCompanion).
                    if this.attributeOmission != nil && this.attributeOmission!!(attribute) {
                        continue
                    }
                    using let modelScope = this.context.UseSemanticModelFor(attribute.SyntaxTree)
                    // ADR-0169 analyzer mode: [DiagnosticAnalyzer(...)] ->
                    // [GSharpDiagnosticAnalyzer] with the language argument
                    // dropped (G# has one language).
                    if this.TryTranslateAnalyzerAttribute(attribute, out var analyzerAttribute) {
                        attributes.Add(analyzerAttribute!!)
                        continue
                    }
                    this.ResolveAttributeType(attribute, out var attributeType, out var sourceAlias)
                    // gsc stamps this marker for `suspend func`; copying the
                    // authored marker as well would duplicate native metadata.
                    if isSuspendingDeclaration &&
                        attributeType != nil &&
                        attributeType.Name == "SuspendingAttribute" &&
                        IsConcurrencyRuntimeNamespace(attributeType.ContainingNamespace) {
                        continue
                    }
                    this.typeMapper.TrackAttributeType(attributeType, sourceAlias)
                    let arguments = List[AttributeArgument]()
                    if attribute.ArgumentList != nil {
                        for argument in attribute.ArgumentList!!.Arguments {
                            let value GExpression? = this.MapAttributeArgumentValue(argument)
                            let name string? = this.TranslateAttributeArgumentName(argument, attributeType)
                            arguments.Add(
                                AttributeArgument(value, name, isMemberAssignment: argument.NameEquals != nil)
                            )
                        }
                    }
                    let attributeName string? = this.TranslateAttributeName(attribute, attributeType, sourceAlias)
                    attributes.Add(AttributeUse(attributeName, arguments, target))
                }
            }
            return attributes
        }

        /// ADR-0184/#4294: maps a property/indexer's own attribute lists,
        /// hoists an accessor-level `[UnscopedRef]` when equivalent, and
        /// reports every other accessor attribute that cannot be represented.
        /// @remarks C# accepts `[UnscopedRef]` on either the property/indexer
        /// or its `get` accessor and treats the two identically — an
        /// expression-bodied indexer emits it on the property row, an
        /// accessor-bodied one on `get_Item`, and
        /// `RefCapabilities.IsUnscopedRefIndexerGetter` reads both
        /// placements back out of metadata.
        ///
        /// G# spells it only at the member level, and
        /// `PropertyAccessor` has no attribute slot at all, so without
        /// this an accessor-level `[UnscopedRef]` vanishes in translation
        /// and the migrated member is rejected by GS0589. Only
        /// `[UnscopedRef]` is hoisted: for any other accessor attribute
        /// (say `[MethodImpl]`) moving it to the property would change what
        /// it means, so it is dropped with a visible warning.
        /// @param node The property or indexer declaration.
        /// @returns The member's attribute list, including any hoisted `@UnscopedRef`.
        private func MapPropertyAttributes(node BasePropertyDeclarationSyntax) List[AttributeUse] {
            let attributes = this.MapAttributes(node.AttributeLists)
            if node.AccessorList == nil {
                return attributes
            }
            let propertySymbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            var hasUnscopedRef = propertySymbol?.GetAttributes().Any(
                (attribute AttributeData) -> this.IsUnscopedRefAttribute(attribute.AttributeClass)
            ) == true
            for accessor in node.AccessorList!!.Accessors {
                for list in accessor.AttributeLists {
                    for attribute in list.Attributes {
                        using let modelScope = this.context.UseSemanticModelFor(attribute.SyntaxTree)
                        this.ResolveAttributeType(attribute, out var attributeType, out var sourceAlias)
                        let isUnscopedRef = this.IsUnscopedRefAttribute(attributeType)
                        // Only a GET-level `[UnscopedRef]` is equivalent to the
                        // member-level placement: the member-level G# annotation
                        // is emitted on the PropertyDef, which a C# consumer
                        // (and gsc's own IsUnscopedRefIndexerGetter) reads as the
                        // GETTER's contract.
                        if isUnscopedRef && accessor.IsKind(
                            Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration
                        ) {
                            if !hasUnscopedRef {
                                this.typeMapper.TrackAttributeType(attributeType, sourceAlias)
                                attributes.Add(
                                    AttributeUse(this.TranslateAttributeName(attribute, attributeType, sourceAlias))
                                )
                                hasUnscopedRef = true
                            }
                            continue
                        }
                        let attributeName = attributeType?.ToDisplayString() ?? attribute.Name.ToString()
                        let member = if node is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .PropertyDeclarationSyntax property {
                            "property '${property.Identifier.ValueText}'"
                        } else {
                            "indexer"
                        }
                        let reason = if isUnscopedRef && hasUnscopedRef {
                            "the $member already has @UnscopedRef, so another member annotation cannot preserve this '${accessor.Keyword.ValueText}'-specific placement"
                        } else {
                            "it was not hoisted because moving it to the member would change its meaning"
                        }
                        this.context.Report(
                            TranslationDiagnostic(
                                accessor.Kind().ToString(),
                                "accessor-level attribute '$attributeName' on the '${accessor.Keyword.ValueText}' accessor of $member has no G# accessor-level representation and was dropped; $reason.",
                                attribute.GetLocation(),
                                TranslationSeverity.Warning
                            ){DiagnosticId = CSharpToGSharpTranslator.AccessorAttributeDroppedDiagnosticId}
                        )
                    }
                }
            }
            return attributes
        }

        private func IsUnscopedRefAttribute(attributeType INamedTypeSymbol?) bool -> SymbolEqualityComparer
            .Default
            .Equals(attributeType, this.unscopedRefAttributeType)

        // Issue #3445: resolve attributes semantically so their containing
        // namespaces and aliases participate in synthesized imports, while
        // retaining source qualification and Attribute-suffix spelling.
        private func ResolveAttributeType(
            attribute AttributeSyntax,
            out attributeType INamedTypeSymbol?,
            out sourceAlias IAliasSymbol?
        ) {
            let symbol ISymbol? = this
                .context
                .GetSymbolInfo(attribute)
                .Symbol ??
                this
                .context
                .GetSymbolInfo(attribute.Name)
                .Symbol
            attributeType = switch symbol {
                case constructor is IMethodSymbol: constructor.ContainingType
                case namedType is INamedTypeSymbol: namedType
                case aliasSymbol is IAliasSymbol: aliasSymbol.Target as INamedTypeSymbol
                default: default(INamedTypeSymbol?)
            }
            sourceAlias = attribute
                .Name
                .DescendantNodesAndSelf()
                .OfType[IdentifierNameSyntax]()
                .Select((identifier IdentifierNameSyntax) -> this.context.SemanticModel.GetAliasInfo(identifier))
                .FirstOrDefault((candidate IAliasSymbol) -> candidate != nil)
        }

        private func TranslateAttributeName(
            attribute AttributeSyntax,
            attributeType INamedTypeSymbol?,
            sourceAlias IAliasSymbol?
        ) string? -> this.TranslateAttributeNameSyntax(attribute.Name, attributeType, sourceAlias, isRightmost: true)

        private func TranslateAttributeNameSyntax(
            nameSyntax NameSyntax,
            attributeType INamedTypeSymbol?,
            sourceAlias IAliasSymbol?,
            isRightmost bool
        ) string? {
            switch nameSyntax {
                case qualified is QualifiedNameSyntax {
                    return this.TranslateAttributeNameSyntax(
                        qualified.Left,
                        attributeType,
                        sourceAlias,
                        isRightmost: false
                    ) +
                        "." +
                        this.TranslateAttributeNameSyntax(qualified.Right, attributeType, sourceAlias, isRightmost)
                }
                case aliasQualified is AliasQualifiedNameSyntax {
                    let alias string? = if aliasQualified.Alias.Identifier.ValueText == "global" {
                        default(string?)
                    } else {
                        this.EmittedName(
                            sourceAlias,
                            aliasQualified.Alias.Identifier.ValueText,
                            GSharpIdentifierNameContext.Type
                        )
                    }
                    let aliasedName string? = this.TranslateAttributeNameSyntax(
                        aliasQualified.Name,
                        attributeType,
                        sourceAlias,
                        isRightmost
                    )
                    return if alias == nil {
                        aliasedName
                    } else {
                        alias + "." + aliasedName
                    }
                }
                case generic is GenericNameSyntax {
                    let genericName string? = this.TranslateAttributeSimpleName(
                        generic.Identifier,
                        generic,
                        attributeType,
                        sourceAlias,
                        isRightmost
                    )
                    let typeArguments = this.MapTypeArguments(generic)
                    return "$genericName[${string.Join(", ", typeArguments.Select(GSharpPrinter.RenderTypeReference))}]"
                }
                case identifier is IdentifierNameSyntax {
                    return this.TranslateAttributeSimpleName(
                        identifier.Identifier,
                        identifier,
                        attributeType,
                        sourceAlias,
                        isRightmost
                    )
                }
                default {
                    return nameSyntax.ToString()
                }
            }
        }

        private func TranslateAttributeSimpleName(
            identifier Microsoft.CodeAnalysis.SyntaxToken,
            syntax SimpleNameSyntax,
            attributeType INamedTypeSymbol?,
            sourceAlias IAliasSymbol?,
            isRightmost bool
        ) string? {
            let sourceName = identifier.ValueText
            let alias IAliasSymbol? = this.context.SemanticModel.GetAliasInfo(syntax)
            if alias != nil {
                return this.EmittedName(alias, sourceName, GSharpIdentifierNameContext.Type)
            }
            if isRightmost &&
                attributeType != nil &&
                attributeType.Name == sourceName +
                "Attribute" &&
                !GSharpSyntaxFacts.IsReservedIdentifier(sourceName, GSharpIdentifierNameContext.Type) {
                return sourceName
            }
            var symbol ISymbol? = this.context.GetSymbolInfo(syntax).Symbol
            if isRightmost && attributeType != nil {
                symbol = attributeType
            }
            return this.EmittedName(symbol ?? sourceAlias, sourceName, GSharpIdentifierNameContext.Type)
        }

        private func TranslateAttributeArgumentName(
            argument AttributeArgumentSyntax,
            attributeType INamedTypeSymbol?
        ) string? {
            let nameSyntax SimpleNameSyntax? = argument.NameEquals?.Name ?? argument.NameColon?.Name
            if nameSyntax == nil {
                return nil
            }
            let sourceName = nameSyntax.Identifier.ValueText
            var symbol ISymbol? = this.context.GetSymbolInfo(nameSyntax).Symbol
            let nameContext = if argument.NameColon != nil {
                GSharpIdentifierNameContext.Parameter
            } else {
                GSharpIdentifierNameContext.General
            }
            if symbol == nil && attributeType != nil {
                symbol = if argument.NameColon != nil {
                    (
                        attributeType
                            .InstanceConstructors
                            .SelectMany(
                            func (constructor IMethodSymbol) IEnumerable[IParameterSymbol] {
                                return constructor.Parameters
                            }
                        )
                            .FirstOrDefault((parameter IParameterSymbol) -> parameter.Name == sourceName) as ISymbol
                    )
                } else {
                    attributeType.GetMembers(sourceName).FirstOrDefault()
                }
            }
            return this.EmittedName(symbol, sourceName, nameContext)
        }

        // Issue #1731 N1: attribute-argument expressions here can never be an
        // `is`-pattern or a range-slice (i.e. can never reach `SpillOperand`'s
        // no-seam fallback). Since #1896 a range-slice does not spill in ANY
        // position — the native `recv[start..end]` form embeds each bound once —
        // so only the `is`-pattern half of this argument still does any work; the
        // range-slice half is kept because it remains true and costs nothing.
        // C# requires every attribute argument to be a
        // compile-time constant (or a `typeof`/array of constants), and
        // neither an `is` pattern-match nor a `x[a..b]` range-slice is ever a
        // constant expression. Native block-expression spilling therefore
        // cannot be needed at this call site.
        private func MapAttributeArgumentValue(argument AttributeArgumentSyntax) GExpression? {
            let constant = this.context.SemanticModel.GetConstantValue(argument.Expression)
            if constant.HasValue {
                // Issue #1733: an enum-typed attribute argument (e.g.
                // `[Kind(Color.Blue)]`) constant-folds to its boxed underlying
                // integer just like an enum-typed parameter default; resolve it to
                // the member reference via the same helper used for
                // <see cref="MapConstantDefault"/> rather than emit the raw int
                // (see <see cref="MapEnumConstant"/> remarks on renumbering).
                let argumentType ITypeSymbol? = this.context.GetTypeInfo(argument.Expression).ConvertedType
                if constant.Value != nil && argumentType?.TypeKind == TypeKind.Enum && IsIntegral(constant.Value) {
                    let enumValue GExpression? = this.MapEnumConstant(
                        argumentType,
                        constant.Value,
                        argument,
                        "attribute argument"
                    )
                    if enumValue != nil {
                        return enumValue
                    }
                }
                switch constant.Value {
                    case nil {
                        return IdentifierExpression("nil")
                    }
                    case s is string {
                        return LiteralExpression.String(s)
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
                    case c is char {
                        return LiteralExpression.Char(c.ToString())
                    }
                    case n is int64 when n == int64.MinValue {
                        return MemberAccessExpression(IdentifierExpression("System.Int64"), "MinValue")
                    }
                    case d is float64 when MapSpecialFloatConstant(d, isDouble: true) is {} specialD {
                        return specialD
                    }
                    case f is float32 when MapSpecialFloatConstant(f, isDouble: false) is {} specialF {
                        return specialF
                    }
                    default {
                        if IsIntegral(constant.Value) {
                            let literal = LiteralExpression.Int(
                                Convert.ToString(constant.Value, CultureInfo.InvariantCulture)
                            )
                            let type ITypeSymbol? = this.context.GetTypeInfo(argument.Expression).Type
                            return if type == nil {
                                cast[GExpression](literal)
                            } else {
                                this.CoerceOperandTo(literal, type, argument.GetLocation())
                            }
                        }
                    }
                }
            }
            // A non-constant attribute argument (an array of constants like
            // `[InlineData(new[] { 3, 1 })]`, a `typeof(X)`, ...) goes through the
            // ordinary expression translator: emitting the verbatim C# text here
            // (the old fallback) produced non-parsing G# — `new[] { … }` can never
            // round-trip — which violates the §B contract that every emitted form
            // is parseable. Constructs the expression translator cannot map still
            // surface loudly through its own diagnostics.
            this.context.Report(
                TranslationDiagnostic(
                    "AttributeArgument",
                    "attribute argument is not a simple constant; translated as an expression (ADR-0115 §B.11).",
                    argument.GetLocation(),
                    TranslationSeverity.Info
                )
            )
            return this.TranslateExpression(argument.Expression)
        }

        /// The single body-translation seam (ADR-0115 §B): a recursive statement /
        /// expression translator over the C# body that produces a parseable G#
        /// (cref:BlockStatement). Constructs with no canonical G# form are
        /// recorded as structured (cref:TranslationDiagnostic) records and
        /// emit the nearest parseable placeholder — never non-parsing text.
        /// @param bodyOwner The C# node that owns the body.
        /// @param description A human-readable label for the body.
        /// @returns The translated block.
        private func TranslateBody(bodyOwner Microsoft.CodeAnalysis.SyntaxNode, description string) BlockStatement {
            let previousScope Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope
            this.state.CurrentBodyScope = bodyOwner
            try {
                var body = this.TranslateBodyCore(bodyOwner, description)
                body = this.WithParameterShadows(bodyOwner, body)
                return body
            } finally {
                this.state.CurrentBodyScope = previousScope
            }
        }

        private func ReportPatternGuardControlTransferMismatch(
            ifStatement Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax,
            emittedHoist IReadOnlyList[GStatement]?,
            translatedBranches IReadOnlyList[GStatement]
        ) {
            // Compare the translated branch nodes by identity before and after
            // hoist assembly. Unrelated method statements cannot affect this
            // invariant, while intentional shared nodes such as filtered-catch
            // rethrows retain their original multiplicity.
            let branchTransfers = Dictionary[GStatement, int32](ReferenceEqualityComparer.Instance)
            for branch in translatedBranches {
                CountTranslatedControlTransferReferences(branch, branchTransfers)
            }
            if branchTransfers.Count == 0 {
                return
            }
            let emittedTransfers = Dictionary[GStatement, int32](ReferenceEqualityComparer.Instance)
            for statement in emittedHoist!! {
                CountTranslatedControlTransferReferences(statement, emittedTransfers)
            }
            if branchTransfers.All(
                (expected KeyValuePair[GStatement, int32]) -> emittedTransfers.TryGetValue(
                    expected.Key,
                    out var actual
                ) &&
                    actual == expected.Value
            ) {
                return
            }
            let branchReturns = branchTransfers.Where(
                (pair KeyValuePair[GStatement, int32]) -> pair.Key is ReturnStatement
            )
                .Sum((pair KeyValuePair[GStatement, int32]) -> pair.Value)
            let branchThrows = branchTransfers.Where(
                (pair KeyValuePair[GStatement, int32]) -> pair.Key is ThrowStatement
            )
                .Sum((pair KeyValuePair[GStatement, int32]) -> pair.Value)
            let emittedReturns = branchTransfers.Where(
                (pair KeyValuePair[GStatement, int32]) -> pair.Key is ReturnStatement
            )
                .Sum(
                (pair KeyValuePair[GStatement, int32]) -> if emittedTransfers.TryGetValue(pair.Key, out var count) {
                    count
                } else {
                    0
                }
            )
            let emittedThrows = branchTransfers.Where(
                (pair KeyValuePair[GStatement, int32]) -> pair.Key is ThrowStatement
            )
                .Sum(
                (pair KeyValuePair[GStatement, int32]) -> if emittedTransfers.TryGetValue(pair.Key, out var count) {
                    count
                } else {
                    0
                }
            )
            let message = "legacy pattern-guard lowering changed translated branch control-transfer structure: " +
                "branches contain $branchReturns return occurrence(s) and $branchThrows throw occurrence(s), " +
                "but emitted hoist preserves $emittedReturns return occurrence(s) and $emittedThrows throw occurrence(s) " +
                "(issue #3418)."
            this.context.Report(
                TranslationDiagnostic(
                    "PatternGuardControlFlow",
                    message,
                    ifStatement.GetLocation(),
                    TranslationSeverity.Unsupported
                )
            )
        }

        // Issue #4302: the single decision point for a lifted local-function
        // helper's readable name. The name is allocated against the aggregate
        // the helper is EMITTED into (owned extensions fold their local
        // functions into the receiver type, not the extension container), and
        // a candidate is accepted only when it is provably collision-free: it
        // is absent from that aggregate's occupied set, no document-scope name
        // claims it, and no source identifier spelled the same way can observe
        // it (`IsLiftedHelperNameMentionedInSource`). Ordinal-suffixed
        // candidates go through the same predicate, so allocation always ends
        // on a proven name; an occupied-set shape this misses becomes a
        // suffix, never a silently rebound call.
        private func AllocateLiftedLocalFunctionName(localFunction IMethodSymbol, localName string?) string? {
            let aggregate INamedTypeSymbol? = this.state.CurrentEmittedAggregate ?? localFunction.ContainingType
            let occupied = this.CollectLiftedHelperOccupiedNames(aggregate, localFunction)
            let allocated string? = LiftedLocalFunctionNameAllocator.For(this.context.Compilation).Allocate(
                localFunction,
                aggregate,
                occupied,
                localName,
                (candidate string) -> this.typeMapper.ClaimsDocumentScopeName(candidate, this.context) ||
                    this.IsLiftedHelperNameMentionedInSource(candidate, aggregate, localFunction)
            )
            this.typeMapper.ReserveSiblingMemberName(allocated)
            return allocated
        }

        private func TryClaimSynthesizedLocalName(
            name string?,
            site Microsoft.CodeAnalysis.SyntaxNode? = nil,
            allowedSourceSymbol ISymbol? = nil
        ) bool {
            if this.SourceIdentifierClaimsSynthesizedLocalName(name, site, allowedSourceSymbol) {
                return false
            }
            let owner INamedTypeSymbol? = this
                .state
                .CurrentEmittedAggregate ??
                this
                .context
                .SemanticModel
                .GetEnclosingSymbol(site?.SpanStart ?? this.state.CurrentBodyScope?.SpanStart ?? 0)
                ?.ContainingType
            return LiftedLocalFunctionNameAllocator.For(this.context.Compilation).TryClaimLocalName(owner, name)
        }

        private func SourceIdentifierClaimsSynthesizedLocalName(
            name string?,
            site Microsoft.CodeAnalysis.SyntaxNode?,
            allowedSourceSymbol ISymbol?
        ) bool {
            let body Microsoft.CodeAnalysis.SyntaxNode? = this.state.CurrentBodyScope ?? site?.SyntaxTree.GetRoot()
            if body == nil {
                return false
            }
            if !this.state.SynthesizedLocalOccupiedNamesByBody.TryGetValue(body, out var occupied) {
                occupied = this.CollectOccupiedSynthesizedLocalNames(body)
                this.state.SynthesizedLocalOccupiedNamesByBody.Add(body, occupied)
            }
            if !occupied.Contains(name!!) || allowedSourceSymbol == nil {
                return occupied.Contains(name!!)
            }
            for token in body.DescendantTokens() {
                if !token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierToken) ||
                    this
                    .nameAllocator
                    .GetName(token.ValueText) != name {
                    continue
                }
                if token.Parent is SimpleNameSyntax simpleName && SymbolEqualityComparer.Default.Equals(
                    this.context.GetSymbolInfo(simpleName).Symbol,
                    allowedSourceSymbol
                ) {
                    continue
                }
                return true
            }
            return false
        }

        private func ReserveSynthesizedLocalName(name string, site Microsoft.CodeAnalysis.SyntaxNode? = nil) bool {
            let owner INamedTypeSymbol? = this
                .state
                .CurrentEmittedAggregate ??
                this
                .context
                .SemanticModel
                .GetEnclosingSymbol(site?.SpanStart ?? this.state.CurrentBodyScope?.SpanStart ?? 0)
                ?.ContainingType
            return LiftedLocalFunctionNameAllocator.For(this.context.Compilation).ReserveLocalName(owner, name)
        }

        private func AllocateSynthesizedLocalName(stem string, site Microsoft.CodeAnalysis.SyntaxNode) string {
            var candidate = stem
            for var suffix = 2; !this.TryClaimSynthesizedLocalName(candidate, site); suffix++ {
                candidate = "${stem}_$suffix"
            }
            return candidate
        }

        // Issue #4302: the names a lifted helper emitted into `aggregate`
        // could collide with that are not visible as source identifiers:
        // metadata members of the aggregate's (and the Roslyn containing
        // type's) hierarchy and interfaces, using-static imports, and the
        // translator's own synthesized helpers and backing fields.
        private func CollectLiftedHelperOccupiedNames(aggregate INamedTypeSymbol?, localFunction IMethodSymbol) HashSet[
            string
        ] {
            let occupied = HashSet[string](StringComparer.Ordinal)
            let roots = List[INamedTypeSymbol]()
            if aggregate != nil {
                roots.Add(aggregate)
            }
            if localFunction.ContainingType != nil && !SymbolEqualityComparer.Default.Equals(
                localFunction.ContainingType,
                aggregate
            ) {
                roots.Add(localFunction.ContainingType!!)
            }
            let containingTypes = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            for root in roots {
                for var type INamedTypeSymbol? = root; type != nil; type = type!!.BaseType {
                    containingTypes.Add(type)
                    occupied.Add(this.EmittedName(type, type.Name)!!)
                    occupied.UnionWith(
                        type.GetMembers().Select((member ISymbol) -> this.EmittedName(member, member.Name)!!)
                    )
                }
                occupied.UnionWith(
                    root
                        .AllInterfaces
                        .SelectMany(
                        func (type INamedTypeSymbol) IEnumerable[ISymbol] {
                            return type.GetMembers()
                        }
                    )
                        .Select((member ISymbol) -> this.EmittedName(member, member.Name)!!)
                )
                occupied.UnionWith(
                    root
                        .InstanceConstructors
                        .SelectMany(
                        func (constructor IMethodSymbol) IEnumerable[IParameterSymbol] {
                            return constructor.Parameters
                        }
                    )
                        .Where(
                        (parameter IParameterSymbol) -> parameter.DeclaringSyntaxReferences.Any(
                            (reference SyntaxReference) -> reference.GetSyntax().Parent?.Parent is TypeDeclarationSyntax
                        )
                    )
                        .Select((parameter IParameterSymbol) -> this.EmittedName(parameter, parameter.Name)!!)
                )
                if this.ownedExtensions.TryGetMethods(root, out var ownedMethods) {
                    for ownedMethod in ownedMethods.Where(this.CanLowerOwnedExtension) {
                        using let ownedModelScope = this.context.UseSemanticModelFor(ownedMethod.SyntaxTree)
                        if this.context.GetDeclaredSymbol(ownedMethod) is IMethodSymbol ownedSymbol {
                            occupied.Add(this.EmittedName(ownedSymbol, ownedSymbol.Name)!!)
                        }
                    }
                }
            }
            for staticUsingTarget in CSharpToGSharpTranslator.GetOrCollectAllStaticUsingTargets(
                this.context.Compilation
            ) {
                for var type INamedTypeSymbol? = staticUsingTarget; type != nil; type = type!!.BaseType {
                    occupied.UnionWith(
                        type.GetMembers().Select((member ISymbol) -> this.EmittedName(member, member.Name)!!)
                    )
                }
            }
            occupied.UnionWith(
                this
                    .state
                    .PendingInstanceSynthHelpers
                    ?.Select((helper MethodDeclaration) -> helper.Name) ??
                    Enumerable.Empty[string]()
            )
            occupied.UnionWith(
                this
                    .state
                    .PendingStaticSynthHelpers
                    ?.Select((helper MethodDeclaration) -> helper.Name) ??
                    Enumerable.Empty[string]()
            )
            for var scope_ ISymbol? = localFunction.ContainingSymbol;
                scope_ is IMethodSymbol;
                scope_ = scope_!!
                .ContainingSymbol {
                for symbol in this.GetLiftedHelperOccupiedSymbols(scope_) {
                    if !SymbolEqualityComparer.Default.Equals(symbol, localFunction) {
                        let name string? = if symbol is IParameterSymbol{Name: "_"} parameter &&
                            parameter
                            .DeclaringSyntaxReferences
                            .FirstOrDefault()
                            ?.GetSyntax() is Microsoft
                            .CodeAnalysis
                            .CSharp
                            .Syntax
                            .ParameterSyntax syntax {
                            this.MapParameterName(parameter, syntax)
                        } else {
                            this.EmittedName(symbol, symbol.Name)
                        }
                        occupied.Add(name!!)
                    }
                }
            }
            occupied.UnionWith(
                this
                    .state
                    .SynthesizedPropertyBackingFieldNames
                    .Where(
                    (pair KeyValuePair[IPropertySymbol, string]) -> containingTypes.Contains(pair.Key.ContainingType!!)
                )
                    .Select((pair KeyValuePair[IPropertySymbol, string]) -> pair.Value)
            )
            occupied.UnionWith(
                containingTypes
                    .SelectMany(
                    func (type INamedTypeSymbol) IEnumerable[IPropertySymbol] {
                        return type.GetMembers().OfType[IPropertySymbol]()
                    }
                )
                    .Where(this.IsBackingFieldLoweredGetOnlyAutoProperty)
                    .Select(
                    (property IPropertySymbol) -> {
                        let name = property.Name
                        return "_" +
                            (
                            if name.Length > 0 {
                                char.ToLowerInvariant(name[0]) + name.Substring(1)
                            } else {
                                name
                            }
                        )
                    }
                )
            )
            return occupied
        }

        private func GetLiftedHelperOccupiedSymbols($scope ISymbol?) IReadOnlyList[ISymbol] {
            if this.liftedHelperOccupiedSymbolsByScope.TryGetValue($scope!!, out var cached) {
                return cached
            }
            let symbols = List[ISymbol]()
            for reference in $scope!!.DeclaringSyntaxReferences {
                using let scopeModel = this.context.UseSemanticModelFor(reference.SyntaxTree)
                symbols.AddRange(
                    reference
                        .GetSyntax()
                        .DescendantNodes()
                        .Where(IsLiftedHelperOccupiedNameDeclaration)
                        .Select(this.context.GetDeclaredSymbol)
                        .Where(
                        (symbol ISymbol) -> symbol is ILocalSymbol ||
                            symbol is IParameterSymbol ||
                            symbol is IRangeVariableSymbol ||
                            (symbol is IMethodSymbol method && method.MethodKind == MethodKind.LocalFunction)
                    )
                )
            }
            this.liftedHelperOccupiedSymbolsByScope.Add($scope!!, symbols)
            return symbols
        }

        // Issue #4302 fail-safe: a readable lifted-helper name is rejected
        // when any identifier token in the compilation spelled the same way
        // could observe the new member. Every source-declared or
        // source-referenced symbol that can shadow or be shadowed by the
        // helper (members in other partial documents, receiver extensions,
        // `this.Helper(1)` calls, using-static imports) leaves such a token.
        // Only tokens that provably cannot interact are ignored: the local
        // function itself, member-scoped symbols declared outside the
        // enclosing member, and members of types unrelated to the emitted
        // aggregate referenced from outside it (or through a qualified
        // access).
        private func IsLiftedHelperNameMentionedInSource(
            name string,
            aggregate INamedTypeSymbol?,
            localFunction IMethodSymbol
        ) bool {
            let owners = HashSet[INamedTypeSymbol](SymbolEqualityComparer.Default)
            if aggregate != nil {
                owners.Add(aggregate.OriginalDefinition)
            }
            if localFunction.ContainingType != nil {
                owners.Add(localFunction.ContainingType.OriginalDefinition)
            }
            var enclosingMember ISymbol? = localFunction.ContainingSymbol
            while enclosingMember is IMethodSymbol enclosingMethod &&
                (
                enclosingMethod.MethodKind == MethodKind.LocalFunction ||
                    enclosingMethod.MethodKind == MethodKind.AnonymousFunction
            ) {
                enclosingMember = enclosingMethod.ContainingSymbol
            }
            let enclosingSpans = List[SyntaxReference]()
            if enclosingMember != nil {
                enclosingSpans.AddRange(enclosingMember.DeclaringSyntaxReferences)
            }
            let aggregateSpans = List[SyntaxReference]()
            for owner in owners {
                aggregateSpans.AddRange(owner.DeclaringSyntaxReferences)
                if this.ownedExtensions.TryGetMethods(owner, out var ownedMethods) {
                    aggregateSpans.AddRange(
                        ownedMethods.Select((method MethodDeclarationSyntax) -> method.GetReference())
                    )
                }
            }
            for tokens in GetIdentifierTokens(this.context.Compilation, name).GroupBy(
                (token Microsoft.CodeAnalysis.SyntaxToken) -> token.SyntaxTree!!
            ) {
                using let modelScope = this.context.UseSemanticModelFor(tokens.Key)
                for token in tokens {
                    if this.LiftedHelperNameTokenCanCollide(
                        token,
                        localFunction,
                        owners,
                        enclosingSpans,
                        aggregateSpans
                    ) {
                        return true
                    }
                }
            }
            return false
        }

        private func LiftedHelperNameTokenCanCollide(
            token Microsoft.CodeAnalysis.SyntaxToken,
            localFunction IMethodSymbol,
            owners HashSet[INamedTypeSymbol],
            enclosingSpans List[SyntaxReference],
            aggregateSpans List[SyntaxReference]
        ) bool {
            let parent Microsoft.CodeAnalysis.SyntaxNode? = token.Parent
            if parent == nil {
                return true
            }
            let symbols = List[ISymbol]()
            var qualified = false
            var qualifiedThroughTypeOrNamespace = false
            if parent is SimpleNameSyntax simpleName {
                let info = this.context.GetSymbolInfo(simpleName)
                if info.Symbol != nil {
                    symbols.Add(info.Symbol!!)
                } else {
                    symbols.AddRange(info.CandidateSymbols)
                }
                qualified = switch simpleName.Parent {
                    case access is MemberAccessExpressionSyntax: access.Name == simpleName &&
                        (
                        CSharpToGSharpTranslator.UnwrapParenthesesAndSuppressions(
                            access.Expression
                        ) is not SimpleNameSyntax receiver ||
                            this
                            .context
                            .GetSymbolInfo(receiver)
                            .Symbol is INamespaceOrTypeSymbol
                    )
                    case _ is MemberBindingExpressionSyntax: true
                    case qualifiedName is QualifiedNameSyntax: qualifiedName.Right == simpleName
                    default: false
                }
                qualifiedThroughTypeOrNamespace = simpleName.Parent is MemberAccessExpressionSyntax qualifiedAccess &&
                    qualifiedAccess.Name == simpleName &&
                    this
                    .context
                    .GetSymbolInfo(
                    CSharpToGSharpTranslator.UnwrapParenthesesAndSuppressions(qualifiedAccess.Expression)
                )
                    .Symbol is INamespaceOrTypeSymbol
            } else {
                let declared ISymbol? = this.context.GetDeclaredSymbol(parent)
                if declared != nil {
                    symbols.Add(declared)
                }
            }
            if symbols.Count == 0 {
                return true
            }
            let insideEnclosingMember = ContainsToken(enclosingSpans, token)
            let insideAggregate = ContainsToken(aggregateSpans, token)
            for candidate in symbols {
                let symbol = if candidate is IMethodSymbol{ReducedFrom: IMethodSymbol reducedFrom} {
                    cast[ISymbol](reducedFrom)
                } else {
                    candidate.OriginalDefinition
                }
                if SymbolEqualityComparer.Default.Equals(symbol, localFunction.OriginalDefinition) {
                    continue
                }
                let memberScoped = symbol is ILocalSymbol ||
                    symbol is IParameterSymbol ||
                    symbol is IRangeVariableSymbol ||
                    symbol is ILabelSymbol ||
                    (symbol is IMethodSymbol localMethod && localMethod.MethodKind == MethodKind.LocalFunction) ||
                    (symbol is ITypeParameterSymbol typeParameter && typeParameter.ContainingSymbol is IMethodSymbol)
                if memberScoped {
                    if insideEnclosingMember {
                        return true
                    }
                    continue
                }
                let unrelatedMember = (
                    symbol is IFieldSymbol ||
                        symbol is IPropertySymbol ||
                        symbol is IEventSymbol ||
                        symbol is IMethodSymbol &&
                        symbol.IsExtensionMethod == false
                ) &&
                    symbol.ContainingType != nil &&
                    !IsTypeRelatedToLiftedHelperOwners(symbol.ContainingType, owners)
                let safelyQualified = qualified &&
                    (!(symbol is IMethodSymbol && symbol.IsExtensionMethod == true) || qualifiedThroughTypeOrNamespace)
                if unrelatedMember && (safelyQualified || !insideAggregate) {
                    continue
                }
                return true
            }
            return false
        }

        private func IsLocalFunctionReferencedAsValue(
            localFunction IMethodSymbol,
            roots IEnumerable[Microsoft.CodeAnalysis.SyntaxNode]
        ) bool -> roots
            .SelectMany(
            func (root Microsoft.CodeAnalysis.SyntaxNode) IEnumerable[SimpleNameSyntax] {
                return root.DescendantNodes().OfType[SimpleNameSyntax]()
            }
        )
            .Any(
            (name SimpleNameSyntax) -> this
                .context
                .GetSymbolInfo(name)
                .Symbol is IMethodSymbol referencedMethod &&
                SymbolEqualityComparer
                .Default
                .Equals(referencedMethod.OriginalDefinition, localFunction) &&
                !(name.Parent is InvocationExpressionSyntax) &&
                !(name.Parent is ArgumentSyntax argument && IsNameOfArgument(argument))
        )

        private func IsLocalFunctionReferencedFromAnotherSwitchSection(
            localFunction IMethodSymbol,
            declaration LocalFunctionStatementSyntax
        ) bool {
            if declaration.Parent is not SwitchSectionSyntax declaringSection ||
                declaringSection.Parent is not Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .SwitchStatementSyntax switchStatement {
                return false
            }
            return switchStatement
                .Sections
                .Where((section SwitchSectionSyntax) -> section != declaringSection)
                .SelectMany(
                func (section SwitchSectionSyntax) IEnumerable[SimpleNameSyntax] {
                    return section.DescendantNodes().OfType[SimpleNameSyntax]()
                }
            )
                .Any(
                (name SimpleNameSyntax) -> this
                    .context
                    .GetSymbolInfo(name)
                    .Symbol is IMethodSymbol referencedMethod &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(referencedMethod.OriginalDefinition, localFunction) &&
                    !(name.Parent is ArgumentSyntax argument && IsNameOfArgument(argument))
            )
        }

        private func IsLocalFunctionReferencedAsValueFromAnotherSwitchSection(
            localFunction IMethodSymbol,
            declaration LocalFunctionStatementSyntax
        ) bool {
            if declaration.Parent is not SwitchSectionSyntax declaringSection ||
                declaringSection.Parent is not Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .SwitchStatementSyntax switchStatement {
                return false
            }
            return this.IsLocalFunctionReferencedAsValue(
                localFunction,
                switchStatement.Sections.Where((section SwitchSectionSyntax) -> section != declaringSection)
            )
        }

        private func IsLocalFunctionReferencedBeforeDeclarationInSwitchSection(
            localFunction IMethodSymbol,
            declaration LocalFunctionStatementSyntax
        ) bool {
            if declaration.Parent is not SwitchSectionSyntax section {
                return false
            }
            return section
                .Statements
                .TakeWhile((statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) -> statement != declaration)
                .SelectMany(
                func (statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) IEnumerable[SimpleNameSyntax] {
                    return statement.DescendantNodes().OfType[SimpleNameSyntax]()
                }
            )
                .Any(
                (name SimpleNameSyntax) -> this
                    .context
                    .GetSymbolInfo(name)
                    .Symbol is IMethodSymbol referencedMethod &&
                    SymbolEqualityComparer
                    .Default
                    .Equals(referencedMethod.OriginalDefinition, localFunction) &&
                    !(name.Parent is ArgumentSyntax argument && IsNameOfArgument(argument))
            )
        }

        // G# function parameters are read-only (Kotlin-style); a C# method that
        // reassigns a value parameter must shadow it with a mutable local at the top
        // of the body (`var p = p`) so the later writes are legal. Parameters that
        // are never reassigned, or that are already `ref`/`out`/`in`, are left alone.
        private func WithParameterShadows(
            bodyOwner Microsoft.CodeAnalysis.SyntaxNode,
            body BlockStatement
        ) BlockStatement {
            let parameters IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]? = switch bodyOwner {
                case method is MethodDeclarationSyntax: method.ParameterList.Parameters
                case op is OperatorDeclarationSyntax: op.ParameterList.Parameters
                case conversion is ConversionOperatorDeclarationSyntax: conversion.ParameterList.Parameters
                case ctor is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .ConstructorDeclarationSyntax: ctor
                    .ParameterList
                    .Parameters
                case localFunction is LocalFunctionStatementSyntax: localFunction.ParameterList.Parameters
                case lambda is ParenthesizedLambdaExpressionSyntax: lambda.ParameterList.Parameters
                case AnonymousMethodExpressionSyntax{
                    ParameterList: not nil
                } anonymous: anonymous.ParameterList!!.Parameters
                case simple is SimpleLambdaExpressionSyntax: cast[
                    IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax]
                ]([]Microsoft.CodeAnalysis.CSharp.Syntax.ParameterSyntax{simple.Parameter})
                default: nil
            }
            if parameters == nil || parameters.Count == 0 {
                return body
            }
            let shadows = List[GStatement]()
            for parameter in parameters {
                if this.context.GetDeclaredSymbol(parameter) is not IParameterSymbol symbol ||
                    symbol.RefKind != RefKind.None ||
                    !this.IsSymbolReassigned(symbol, bodyOwner) {
                    continue
                }
                let name string? = MapParameterName(symbol, parameter)
                shadows.Add(LocalDeclarationStatement(BindingKind.Var, name, type: nil, IdentifierExpression(name)))
            }
            if shadows.Count == 0 {
                return body
            }
            shadows.AddRange(body.Statements)
            return BlockStatement(shadows, body.IsUnsafe)
        }

        private func TranslateBodyCore(bodyOwner Microsoft.CodeAnalysis.SyntaxNode, description string) BlockStatement {
            switch bodyOwner {
                case method is MethodDeclarationSyntax {
                    if method.Body != nil {
                        return this.TranslateBlock(method.Body)
                    }
                    if method.ExpressionBody != nil {
                        let returnsVoid = (this.context.GetDeclaredSymbol(method) as IMethodSymbol)?.ReturnsVoid ??
                            false
                        return this.WrapExpressionBody(method.ExpressionBody!!.Expression, returnsVoid)
                    }
                }
                case op is OperatorDeclarationSyntax {
                    if op.Body != nil {
                        return this.TranslateBlock(op.Body)
                    }
                    if op.ExpressionBody != nil {
                        return this.WrapExpressionBody(op.ExpressionBody!!.Expression, isVoid: false)
                    }
                }
                case conversion is ConversionOperatorDeclarationSyntax {
                    if conversion.Body != nil {
                        return this.TranslateBlock(conversion.Body)
                    }
                    if conversion.ExpressionBody != nil {
                        return this.WrapExpressionBody(conversion.ExpressionBody!!.Expression, isVoid: false)
                    }
                }
                case ctor is Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax {
                    if ctor.Body != nil {
                        return this.TranslateBlock(ctor.Body)
                    }
                    if ctor.ExpressionBody != nil {
                        return this.WrapExpressionBody(ctor.ExpressionBody!!.Expression, isVoid: true)
                    }
                }
                case accessor is AccessorDeclarationSyntax {
                    if accessor.Body != nil {
                        return this.TranslateBlock(accessor.Body)
                    }
                    if accessor.ExpressionBody != nil {
                        let isGetter = accessor.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.GetAccessorDeclaration)
                        return this.WrapExpressionBody(accessor.ExpressionBody!!.Expression, isVoid: !isGetter)
                    }
                }
                case property is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .PropertyDeclarationSyntax when property.ExpressionBody != nil {
                    // An expression-bodied property is a get-only computed property.
                    return this.WrapExpressionBody(property.ExpressionBody!!.Expression, isVoid: false)
                }
                case indexer is IndexerDeclarationSyntax when indexer.ExpressionBody != nil {
                    // An expression-bodied indexer is a get-only computed indexer.
                    return this.WrapExpressionBody(indexer.ExpressionBody!!.Expression, isVoid: false)
                }
                case destructor is DestructorDeclarationSyntax {
                    if destructor.Body != nil {
                        return this.TranslateBlock(destructor.Body)
                    }
                    if destructor.ExpressionBody != nil {
                        return this.WrapExpressionBody(destructor.ExpressionBody!!.Expression, isVoid: true)
                    }
                }
                case localFunction is LocalFunctionStatementSyntax {
                    if localFunction.Body != nil {
                        return this.TranslateBlock(localFunction.Body)
                    }
                    if localFunction.ExpressionBody != nil {
                        let returnsVoidLocal = (
                            this.context.GetDeclaredSymbol(localFunction) as IMethodSymbol
                        )?.ReturnsVoid ??
                            false
                        return this.WrapExpressionBody(localFunction.ExpressionBody!!.Expression, returnsVoidLocal)
                    }
                }
            }
            // No recognizable body; emit an empty parseable block.
            return BlockStatement(List[GStatement]())
        }

        private func WrapExpressionBody(
            expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax,
            isVoid bool
        ) BlockStatement {
            if expression is Microsoft.CodeAnalysis.CSharp.Syntax.ThrowExpressionSyntax bareThrow {
                // `=> throw e` is a diverging body; G# `throw` is a statement, so
                // emit it directly rather than wrapping a value (ADR-0115 §B).
                return BlockStatement(List[GStatement]{ThrowStatement(this.TranslateExpression(bareThrow.Expression))})
            }
            if isVoid {
                // A void expression body is an executed statement (often an
                // assignment, which is statement-only in G#), so route it through
                // the statement seam rather than wrapping the value. It behaves
                // like `TranslateStatement` for spill-hoisting purposes (issue
                // #1731): it has no OUTER statement of its own, so it opens its
                // own seam via <see cref="WithSpillSeam"/>.
                return BlockStatement(
                    this.WithSpillSeam(
                        func () IReadOnlyList[GStatement] {
                            return this.TranslateExpressionStatements(expression)!!.ToList()
                        }
                    )
                        .ToList()
                )
            }
            // A non-void expression body is a `return expr`. Route the returned
            // value through the null-forgiveness pass (issue #1354) exactly like
            // a statement-form `return expr;` does, so a promoted-nullable value
            // (`T?`) returned where the member is declared non-null `T` gets its
            // flow-proven `!!` assertion (e.g. `prop OperationTask Task ->
            // Continuation!!`). Using plain TranslateExpression here left
            // expression-bodied members without the assertion → GS0155.
            // Issue #3839: `=> ref lvalue` is a BY-REF return, exactly as
            // `return ref lvalue;` is in statement form — and the statement form
            // has always carried `isRef` here (see the ReturnStatementSyntax case
            // in TranslateStatements). Dropping it on the expression-bodied path
            // emitted a plain `return` out of a member still declared `ref T`,
            // which gsc rejects with GS0252.
            let isRefReturn = expression is RefExpressionSyntax
            return BlockStatement(
                this.WithSpillSeam(
                    func () IReadOnlyList[GStatement] {
                        return this.WithHoistedPostfix(
                            expression,
                            () -> this.WithHoistedAssignments(
                                expression,
                                includeSelf: true,
                                () -> List[GStatement]{
                                    ReturnStatement(
                                        this.TranslateValueWithNullForgiveness(expression),
                                        isRef: isRefReturn
                                    )
                                }
                            )
                        )
                            .ToList()
                    }
                )
                    .ToList()
            )
        }

        private func TranslateBlock(block BlockSyntax?) BlockStatement {
            let statements = List[GStatement]()
            let ordered = this.HoistCallBeforeDeclLocalFunctions(block)
            // Register structural nullable groups first; the fallback pass then
            // handles only signatures that cannot use that representation.
            this.RegisterCapturingRecursiveLocalFunctions(ordered)
            this.RegisterRecursiveLocalFunctionLifts(ordered)
            // Issue #4262 follow-up (item 2): symbols already captured by an
            // earlier early-return guard IN THIS BLOCK, so a redundant later
            // guard on the same (still-unwritten) field skips re-capturing,
            // and the derived local names already used in this block, so a
            // second guard whose derived name collides with an earlier
            // capture's falls back instead of colliding
            // (see EmitGuardedFieldLocalCaptures).
            let activeGuardCaptures = Dictionary[ISymbol, Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax](
                SymbolEqualityComparer.Default
            )
            let capturedNamesInScope = HashSet[string]()
            for statement in ordered {
                statements.AddRange(this.TranslateStatement(statement))
                if statement is Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax ifStatement {
                    this.EmitGuardedFieldLocalCaptures(
                        ifStatement,
                        activeGuardCaptures,
                        capturedNamesInScope,
                        statements
                    )
                }
            }
            this.AppendDanglingComments(statements, block!!.CloseBraceToken)
            return BlockStatement(statements)
        }

        private func RegisterRecursiveLocalFunctionLifts(
            statements IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]
        ) -> this
            .RegisterRecursiveLocalFunctionLifts(
            statements,
            (_ IReadOnlyCollection[IMethodSymbol]) -> false,
            processOnlyForcedGroups: false
        )

        private func RegisterRecursiveLocalFunctionLifts(
            statements IEnumerable[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax],
            forceLiftGroup(IReadOnlyCollection[IMethodSymbol]) -> bool,
            processOnlyForcedGroups bool
        ) {
            let HasGenericContainingType = func (symbol IMethodSymbol) bool {
                for var type INamedTypeSymbol? = symbol.ContainingType; type != nil; type = type!!.ContainingType {
                    if type.IsGenericType {
                        return true
                    }
                }
                return false
            }
            let IsInsideNameOf = func (operation IOperation) bool {
                for var current IOperation? = operation; current != nil; current = current!!.Parent {
                    if current is INameOfOperation {
                        return true
                    }
                }
                return false
            }
            let ReferencesEnclosingTypeParameter = func (
                candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol),
                includeContainingTypeParameters bool
            ) bool {
                let enclosingTypeParameters = HashSet[ITypeParameterSymbol](SymbolEqualityComparer.Default)
                for var owner ISymbol? = candidate
                    .Symbol
                    .ContainingSymbol;
                    owner != nil;
                    owner = owner!!
                    .ContainingSymbol {
                    if owner is IMethodSymbol method {
                        enclosingTypeParameters.UnionWith(method.TypeParameters)
                    } else if includeContainingTypeParameters && owner is INamedTypeSymbol type {
                        enclosingTypeParameters.UnionWith(type.TypeParameters)
                    }
                }
                using let modelScope = this.context.UseSemanticModelFor(candidate.Syntax.SyntaxTree)
                if this
                    .context
                    .SemanticModel
                    .GetOperation(candidate.Syntax)
                    ?.DescendantsAndSelf()
                    .OfType[IInstanceReferenceOperation]()
                    .Any(
                    (instance IInstanceReferenceOperation) -> !IsInsideNameOf(instance) &&
                        instance.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance &&
                        instance.Type != nil &&
                        enclosingTypeParameters.Any(
                        (enclosing ITypeParameterSymbol) -> TypeContainsTypeParameter(instance.Type, enclosing)
                    )
                ) == true {
                    return true
                }
                // `nameof(T)` translates to a string literal, so its operand is
                // not a type-parameter dependency.
                return candidate
                    .Syntax
                    .DescendantNodes(
                    (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                        node is InvocationExpressionSyntax &&
                            this
                            .context
                            .SemanticModel
                            .GetOperation(node) is INameOfOperation
                    )
                )
                    .Select((node Microsoft.CodeAnalysis.SyntaxNode) -> this.context.GetSymbolInfo(node).Symbol)
                    .Any(
                    (symbol ISymbol) -> (
                        symbol is ITypeParameterSymbol typeParameter && enclosingTypeParameters.Contains(typeParameter)
                    ) ||
                        (
                        symbol is IMethodSymbol method &&
                            method.MethodKind != MethodKind.LocalFunction &&
                            method.ContainingType != nil &&
                            enclosingTypeParameters.Any(
                            (enclosing ITypeParameterSymbol) -> TypeContainsTypeParameter(
                                method.ContainingType,
                                enclosing
                            )
                        )
                    ) ||
                        (
                        (symbol is IFieldSymbol || symbol is IPropertySymbol || symbol is IEventSymbol) &&
                            symbol.ContainingType != nil &&
                            enclosingTypeParameters.Any(
                            (enclosing ITypeParameterSymbol) -> TypeContainsTypeParameter(
                                symbol.ContainingType,
                                enclosing
                            )
                        )
                    ) ||
                        (
                        symbol is ILocalSymbol local && enclosingTypeParameters.Any(
                            (enclosing ITypeParameterSymbol) -> TypeContainsTypeParameter(local.Type, enclosing)
                        )
                    ) ||
                        (
                        symbol is IParameterSymbol parameter && enclosingTypeParameters.Any(
                            (enclosing ITypeParameterSymbol) -> TypeContainsTypeParameter(parameter.Type, enclosing)
                        )
                    )
                )
            }
            // Issue #3399 (hybrid lowering) / #4197 (widened): a registering
            // mutual-recursion SCC's members — and any non-recursive callee
            // folded into that same group — lower to G# nullable function
            // locals (see `RegisterCapturingRecursiveLocalFunctions`, which
            // runs first) instead of synthetic instance/static helpers — skip
            // them here so both the registration below and the
            // `TranslateLocalFunction` helper emission stay out of the way.
            let IsCapturingRecursiveGroupMember = func (symbol IMethodSymbol) bool {
                return this.state.RecursiveLocalFunctionGroups.ContainsKey(symbol)
            }
            // Empty statements emit nothing, so they must not separate a
            // native group from an adjacent local function.
            let statementList = statements.Where(
                (statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) -> !(statement is EmptyStatementSyntax)
            )
                .ToList()
            let statementIndexes = Dictionary[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax, int32]()
            for var index = 0; index < statementList.Count; index++ {
                statementIndexes.TryAdd(statementList[index], index)
            }
            let localFunctions = List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]()
            for localFunction in statementList.OfType[LocalFunctionStatementSyntax]() {
                using let modelScope = this.context.UseSemanticModelFor(localFunction.SyntaxTree)
                if this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol symbol {
                    localFunctions.Add((localFunction, symbol))
                }
            }
            let symbols = HashSet[IMethodSymbol](
                localFunctions.Select((pair(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> pair.Symbol),
                SymbolEqualityComparer.Default
            )
            let edges = Dictionary[IMethodSymbol, HashSet[IMethodSymbol]](SymbolEqualityComparer.Default)
            for pair in localFunctions {
                using let modelScope = this.context.UseSemanticModelFor(pair.Syntax.SyntaxTree)
                let dependencies = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
                for node in pair.Syntax.DescendantNodes() {
                    if this.context.GetSymbolInfo(node).Symbol is IMethodSymbol dependency && symbols.Contains(
                        dependency.OriginalDefinition
                    ) {
                        dependencies.Add(dependency.OriginalDefinition)
                    }
                }
                edges[pair.Symbol] = dependencies
            }
            let IsRecursive = func (start IMethodSymbol, current IMethodSymbol, visited HashSet[IMethodSymbol]) bool {
                if !edges.TryGetValue(current, out var dependencies) {
                    return false
                }
                for dependency in dependencies {
                    if SymbolEqualityComparer.Default.Equals(dependency, start) {
                        return true
                    }
                    if visited.Add(dependency) && IsRecursive(start, dependency, visited) {
                        return true
                    }
                }
                return false
            }
            let GetRecursiveComponent = func (member IMethodSymbol) List[
                (Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)
            ] {
                return localFunctions.Where(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> IsRecursive(
                        member,
                        candidate.Symbol,
                        HashSet[IMethodSymbol](SymbolEqualityComparer.Default){candidate.Symbol}
                    ) &&
                        IsRecursive(
                        candidate.Symbol,
                        member,
                        HashSet[IMethodSymbol](SymbolEqualityComparer.Default){member}
                    )
                )
                    .ToList()
            }
            let GetDependencyClosure = func (
                roots IEnumerable[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]
            ) List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)] {
                let reachable = HashSet[IMethodSymbol](
                    roots.Select(
                        (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate.Symbol
                    ),
                    SymbolEqualityComparer.Default
                )
                let pending = Stack[IMethodSymbol](reachable)
                while pending.Count > 0 {
                    if !edges.TryGetValue(pending.Pop(), out var dependencies) {
                        continue
                    }
                    for dependency in dependencies {
                        if reachable.Add(dependency) {
                            pending.Push(dependency)
                        }
                    }
                }
                return localFunctions.Where(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> reachable.Contains(
                        candidate.Symbol
                    )
                )
                    .ToList()
            }
            let CanUseNativeLocalFunctionGroup = func (
                component List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]
            ) bool {
                if component.Count < 2 {
                    return false
                }
                let generic = component[0].Syntax.TypeParameterList != nil
                let refReturn = component[0].Symbol.ReturnsByRef
                // gsc hosts a generic local group under a generic type without
                // the owner's private access (GS0472/GS0586); the member helper
                // keeps it, unless the group names a method type parameter the
                // helper cannot see.
                if component.Any(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate
                        .Symbol
                        .ReturnsByRefReadonly ||
                        (candidate.Syntax.TypeParameterList != nil) != generic ||
                        candidate
                        .Symbol
                        .ReturnsByRef != refReturn
                ) ||
                    (generic && refReturn) ||
                    (
                    generic && HasGenericContainingType(component[0].Symbol) && !GetDependencyClosure(component).Any(
                        (
                            candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)
                        ) -> ReferencesEnclosingTypeParameter(candidate, includeContainingTypeParameters: false)
                    )
                ) ||
                    component
                    .Any(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate
                        .Syntax
                        .ConstraintClauses
                        .Count > 0
                ) ||
                    (
                    refReturn && component.Any(
                        (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> !candidate
                            .Symbol
                            .IsStatic
                    )
                ) ||
                    component
                    .Any(
                    (
                        candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)
                    ) -> this.IsLocalFunctionReferencedAsValue(candidate.Symbol, statementList)
                ) {
                    return false
                }
                let componentSymbols = HashSet[IMethodSymbol](
                    component.Select(
                        (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate.Symbol
                    ),
                    SymbolEqualityComparer.Default
                )
                let componentStart = component.Select(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> statementIndexes[
                        candidate.Syntax
                    ]
                )
                    .Min()
                if component.Any(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> edges[candidate.Symbol]
                        .Any(
                        (dependency IMethodSymbol) -> !componentSymbols.Contains(dependency) && localFunctions.Any(
                            (other(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> SymbolEqualityComparer
                                .Default
                                .Equals(other.Symbol, dependency) && statementIndexes[other.Syntax] >= componentStart
                        )
                    )
                ) {
                    return false
                }
                let indexes = component
                    .Select(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> statementIndexes[
                        candidate.Syntax
                    ]
                )
                    .OrderBy((index int32) -> index)
                    .ToList()
                if indexes[^1] - indexes[0] + 1 != indexes.Count {
                    return false
                }
                return (indexes[0] == 0 || !(statementList[indexes[0] - 1] is LocalFunctionStatementSyntax)) &&
                    (
                    indexes[^1] == statementList.Count - 1 ||
                        !(statementList[indexes[^1] + 1] is LocalFunctionStatementSyntax)
                )
            }
            let CapturesOuterValue = func (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) bool {
                using let modelScope = this.context.UseSemanticModelFor(candidate.Syntax.SyntaxTree)
                if !candidate
                    .Symbol
                    .IsStatic &&
                    this
                    .context
                    .SemanticModel
                    .GetOperation(candidate.Syntax)
                    ?.DescendantsAndSelf()
                    .Any(
                    (operation IOperation) -> !IsInsideNameOf(operation) &&
                        operation is IInstanceReferenceOperation instance &&
                        instance.ReferenceKind == InstanceReferenceKind.ContainingTypeInstance
                ) == true {
                    return true
                }
                for identifier in candidate
                    .Syntax
                    .DescendantNodes(
                    (node Microsoft.CodeAnalysis.SyntaxNode) -> !(
                        node is InvocationExpressionSyntax &&
                            this
                            .context
                            .SemanticModel
                            .GetOperation(node) is INameOfOperation
                    )
                )
                    .OfType[IdentifierNameSyntax]() {
                    let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
                    if !(symbol is ILocalSymbol) &&
                        !(symbol is IParameterSymbol) ||
                        symbol!!
                        .DeclaringSyntaxReferences
                        .Any((reference SyntaxReference) -> candidate.Syntax.Span.Contains(reference.Span)) {
                        continue
                    }
                    for var owner ISymbol? = candidate
                        .Symbol
                        .ContainingSymbol;
                        owner is IMethodSymbol;
                        owner = owner!!.ContainingSymbol {
                        if SymbolEqualityComparer.Default.Equals(symbol!!.ContainingSymbol, owner) {
                            return true
                        }
                    }
                }
                return false
            }
            let toLift = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
            for pair in localFunctions {
                // Issue #3501 A2: gsc `let`-bound function literals can now
                // reference their own binding, so DIRECT self-recursion no
                // longer forces a lift — only a cycle that passes through
                // ANOTHER local function does (the partner would have to be
                // forward-referenced before its `let` declaration).
                let recursiveThroughOthers = edges.TryGetValue(pair.Symbol, out var ownDependencies) &&
                    ownDependencies
                    .Any(
                    (dependency IMethodSymbol) -> !SymbolEqualityComparer.Default.Equals(dependency, pair.Symbol) &&
                        IsRecursive(
                        pair.Symbol,
                        dependency,
                        HashSet[IMethodSymbol](SymbolEqualityComparer.Default){dependency}
                    )
                )
                let selfRecursive = ownDependencies.Any(
                    (dependency IMethodSymbol) -> SymbolEqualityComparer.Default.Equals(dependency, pair.Symbol)
                )
                let recursive = recursiveThroughOthers || selfRecursive
                let component = GetRecursiveComponent(pair.Symbol)
                let forceLift = forceLiftGroup(
                    component.Select(
                        (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate.Symbol
                    )
                        .ToList()
                )
                if processOnlyForcedGroups && !forceLift {
                    continue
                }
                let dependencyClosure = GetDependencyClosure(component)
                let canUseNativeGroup = CanUseNativeLocalFunctionGroup(component)
                // A member fallback cannot name an enclosing method type parameter,
                // while native generic closure lowering rejects this shape with GS0468.
                // Include the callee closure because calling a capturing local captures
                // that binding even when the recursive SCC does not name the value itself.
                let unsupportedCapturingGeneric = recursive && component.Any(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate
                        .Syntax
                        .TypeParameterList != nil
                ) &&
                    dependencyClosure
                    .Any(
                    (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> CapturesOuterValue(
                        candidate
                    )
                ) &&
                    dependencyClosure
                    .Any(
                    (
                        candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)
                    ) -> ReferencesEnclosingTypeParameter(candidate, includeContainingTypeParameters: true)
                )
                let unsupportedFallbackMethodTypeParameter = recursive &&
                    (
                    forceLift ||
                        (recursiveThroughOthers && !IsCapturingRecursiveGroupMember(pair.Symbol) && !canUseNativeGroup)
                ) &&
                    dependencyClosure
                    .Any(
                    (
                        candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)
                    ) -> ReferencesEnclosingTypeParameter(candidate, includeContainingTypeParameters: false)
                )
                if unsupportedCapturingGeneric || unsupportedFallbackMethodTypeParameter {
                    this
                        .state
                        .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                        .UnionWith(
                        component.Select(
                            (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate.Symbol
                        )
                    )
                    continue
                }
                // Issue #3501: gsc `let`-bound function literals now declare
                // and call through ref/out/in parameters (A2 + the ref-kind
                // call-site modifier), so a ref-kind signature alone no longer
                // forces a lift — only a recursion cycle through ANOTHER local
                // function does (the partner would be forward-referenced
                // before its `let` declaration).
                if (forceLift && recursive) ||
                    (recursiveThroughOthers && (IsCapturingRecursiveGroupMember(pair.Symbol) || !canUseNativeGroup)) {
                    toLift.Add(pair.Symbol)
                }
            }
            let pending = Stack[IMethodSymbol](toLift)
            while pending.Count > 0 {
                let current = pending.Pop()
                if !edges.TryGetValue(current, out var dependencies) {
                    continue
                }
                for dependency in dependencies {
                    if !this
                        .state
                        .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                        .Contains(dependency) &&
                        toLift.Add(dependency) {
                        pending.Push(dependency)
                    }
                }
            }
            if this.state.PendingStaticSynthHelpers == nil && this.state.PendingInstanceSynthHelpers == nil {
                this
                    .state
                    .UnsupportedTopLevelRecursiveLocalFunctions
                    .UnionWith(toLift.Where((symbol IMethodSymbol) -> !IsCapturingRecursiveGroupMember(symbol)))
                return
            }
            for pair in localFunctions.Where(
                (pair(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> pair.Symbol.IsStatic
            ) {
                if this.state.LiftedStaticLocalFunctions.ContainsKey(pair.Symbol) || !toLift.Contains(pair.Symbol) ||
                    this
                    .state
                    .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                    .Contains(pair.Symbol) ||
                    IsCapturingRecursiveGroupMember(pair.Symbol) {
                    continue
                }
                let localName string? = this.EmittedName(pair.Symbol, pair.Syntax.Identifier.ValueText)
                this.state.LiftedStaticLocalFunctions[pair.Symbol] = this.AllocateLiftedLocalFunctionName(
                    pair.Symbol,
                    localName
                )!!
            }
            let capturingLocals = localFunctions.Where(
                (pair(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> !pair
                    .Symbol
                    .IsStatic &&
                    toLift.Contains(pair.Symbol) &&
                    !this
                    .state
                    .UnsupportedRecursiveEnclosingTypeParameterLocalFunctions
                    .Contains(pair.Symbol) &&
                    !IsCapturingRecursiveGroupMember(pair.Symbol)
            )
                .ToList()
            if capturingLocals.Count == 0 {
                return
            }
            let directCaptures = Dictionary[IMethodSymbol, HashSet[ISymbol]](SymbolEqualityComparer.Default)
            for pair in capturingLocals {
                let captures = HashSet[ISymbol](SymbolEqualityComparer.Default)
                for identifier in pair.Syntax.DescendantNodes().OfType[IdentifierNameSyntax]() {
                    let symbol ISymbol? = this.context.GetSymbolInfo(identifier).Symbol
                    if !(symbol is ILocalSymbol) && !(symbol is IParameterSymbol) {
                        continue
                    }
                    var lexicalOwner = false
                    for var owner ISymbol? = pair
                        .Symbol
                        .ContainingSymbol;
                        owner is IMethodSymbol;
                        owner = owner!!.ContainingSymbol {
                        if SymbolEqualityComparer.Default.Equals(symbol!!.ContainingSymbol, owner) {
                            lexicalOwner = true
                            break
                        }
                    }
                    if !lexicalOwner {
                        continue
                    }
                    let declaredInside = symbol!!.DeclaringSyntaxReferences.Any(
                        (reference SyntaxReference) -> pair.Syntax.Span.Contains(reference.Span)
                    )
                    if !declaredInside {
                        captures.Add(symbol!!)
                    }
                }
                directCaptures[pair.Symbol] = captures
            }
            var changed bool
            do {
                changed = false
                for pair in capturingLocals {
                    if !edges.TryGetValue(pair.Symbol, out var dependencies) {
                        continue
                    }
                    for dependency in dependencies {
                        if !directCaptures.TryGetValue(dependency, out var dependencyCaptures) {
                            continue
                        }
                        for capture in dependencyCaptures {
                            changed |= directCaptures[pair.Symbol].Add(capture)
                        }
                    }
                }
            } while changed
            for pair in capturingLocals {
                if (pair.Symbol.IsAsync || IsIteratorBody(pair.Syntax)) && directCaptures[pair.Symbol].Any(
                    this.IsCaptureWrittenInDeclaringScope
                ) {
                    this.state.UnsupportedSuspendingRefCaptureLocalFunctions.Add(pair.Symbol)
                    this
                        .state
                        .UnsupportedSuspendingRefCaptureLocalFunctions
                        .UnionWith(
                        GetRecursiveComponent(pair.Symbol).Select(
                            (candidate(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> candidate.Symbol
                        )
                    )
                }
            }
            for pair in capturingLocals {
                if this
                    .state
                    .LiftedRecursiveLocalFunctions
                    .ContainsKey(pair.Symbol) ||
                    this
                    .state
                    .UnsupportedSuspendingRefCaptureLocalFunctions
                    .Contains(pair.Symbol) {
                    continue
                }
                let captures = directCaptures[pair.Symbol]
                    .OrderBy((symbol ISymbol) -> symbol.Locations.FirstOrDefault()?.SourceSpan.Start ?? int32.MaxValue)
                    .ThenBy((symbol ISymbol) -> symbol.Name, StringComparer.Ordinal)
                    .Select(
                    (symbol ISymbol) -> LiftedLocalFunctionCapture(
                        symbol,
                        this.IsCaptureWrittenInDeclaringScope(symbol)
                    )
                )
                    .ToList()
                var containingMethod IMethodSymbol? = pair.Symbol.ContainingSymbol as IMethodSymbol
                while containingMethod?.MethodKind == MethodKind.LocalFunction {
                    containingMethod = containingMethod!!.ContainingSymbol as IMethodSymbol
                }
                let localName string? = this.EmittedName(pair.Symbol, pair.Syntax.Identifier.ValueText)
                this
                    .state
                    .LiftedRecursiveLocalFunctions[pair.Symbol] = LiftedRecursiveLocalFunction(
                    this.AllocateLiftedLocalFunctionName(pair.Symbol, localName),
                    containingMethod?.IsStatic != false,
                    captures
                )
            }
        }

        // Issue #4302: a lifted helper receives its captures as parameters, so
        // any write that the original closure cell would observe (a lambda,
        // another local function, or the member body itself) must keep the
        // capture by-ref to preserve shared storage.
        private func IsCaptureWrittenInDeclaringScope(capture ISymbol) bool -> capture
            .ContainingSymbol
            .DeclaringSyntaxReferences
            .Any((reference SyntaxReference) -> this.IsSymbolReassigned(capture, reference.GetSyntax()))

        // Issues #3399/#4197: ordinary mutual recursion uses nullable
        // function locals so every member is declared before any body binds.
        // Generic, ref-returning, variadic, and ref-kind signatures cannot be
        // represented by that structural arrow type, so this pass excludes
        // them. Issue #4302 routes a consecutive homogeneous excluded group
        // through gsc's native direct-local-function group instead; only
        // compiler-deferred mixed groups use readable source-named member
        // helpers. Non-recursive callees reached solely from a claimed group
        // fold into that group, including optional-parameter helpers whose
        // omitted defaults are materialized at translated call sites.
        private func RegisterCapturingRecursiveLocalFunctions(
            statements IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]
        ) {
            // Callable storage belongs to this declaring block's activation.
            // Descendant helpers are registered by their own block, never folded
            // into an enclosing cycle's shared slots (#4802). Dependency scans
            // still inspect nested bodies for references to these siblings.
            let localFunctionStatements = statements.OfType[LocalFunctionStatementSyntax]().ToList()
            let functions = List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]()
            let excluded = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
            for localFunction in localFunctionStatements.OfType[LocalFunctionStatementSyntax]() {
                using let modelScope = this.context.UseSemanticModelFor(localFunction.SyntaxTree)
                if this.context.GetDeclaredSymbol(localFunction) is not IMethodSymbol symbol {
                    continue
                }
                // These signatures cannot use the nullable structural
                // arrow declaration. Native homogeneous groups and the
                // readable mixed-group fallback are selected later.
                if localFunction.TypeParameterList != nil || symbol.ReturnsByRef || symbol.Parameters.Any(
                    IsVariadicCarrierParameter
                ) ||
                    symbol
                    .Parameters
                    .Any((parameter IParameterSymbol) -> parameter.RefKind != RefKind.None) {
                    excluded.Add(symbol)
                }
                // A local function already lifted as a shared helper has
                // working recursion there — nothing to do for it.
                if this
                    .state
                    .LiftedStaticLocalFunctions
                    .ContainsKey(symbol) ||
                    this
                    .state
                    .LiftedRecursiveLocalFunctions
                    .ContainsKey(symbol) {
                    continue
                }
                functions.Add((localFunction, symbol))
            }
            if functions.Count == 0 {
                return
            }
            let reachableFunctions = HashSet[IMethodSymbol](
                functions.Select((f(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> f.Symbol),
                SymbolEqualityComparer.Default
            )
            let edges = Dictionary[IMethodSymbol, HashSet[IMethodSymbol]](SymbolEqualityComparer.Default)
            for (syntax, symbol) in functions {
                using let modelScope = this.context.UseSemanticModelFor(syntax.SyntaxTree)
                let dependencies = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
                for node in syntax.DescendantNodes() {
                    if this
                        .context
                        .GetSymbolInfo(node)
                        .Symbol is IMethodSymbol dependency &&
                        reachableFunctions.Contains(dependency.OriginalDefinition) {
                        dependencies.Add(dependency.OriginalDefinition)
                    }
                }
                edges[symbol] = dependencies
            }
            let reach = Dictionary[IMethodSymbol, HashSet[IMethodSymbol]](SymbolEqualityComparer.Default)
            for symbol in reachableFunctions {
                let reachable = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
                let stack = Stack[IMethodSymbol]()
                stack.Push(symbol)
                while stack.Count > 0 {
                    let current = stack.Pop()
                    for dependency in edges[current] {
                        if reachable.Add(dependency) {
                            stack.Push(dependency)
                        }
                    }
                }
                reach[symbol] = reachable
            }
            // A symbol that can reach itself is recursive; each recursive symbol
            // belongs to the strongly-connected component formed by the recursive
            // symbols it mutually reaches (transitive within one component, so the
            // first matching group is the right one).
            let groups = List[List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]]()
            for (syntax, symbol) in functions {
                if !reach[symbol].Contains(symbol) {
                    continue
                }
                var group List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]? = nil
                for candidate in groups {
                    let head = candidate[0].Symbol
                    if reach[head].Contains(symbol) && reach[symbol].Contains(head) {
                        group = candidate
                    }
                }
                if group == nil {
                    group = List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]()
                    groups.Add(group)
                }
                group.Add((syntax, symbol))
            }
            // Issue #4197: every member of a genuinely recursive SCC now gets
            // the group; capturing is no longer the gate (see the removed
            // per-group check below). `sccMembers` is every symbol that is
            // itself part of SOME cycle (including single-member self-recursion,
            // which still keeps the plain `let` path) — used below to keep a
            // cycle member of a DIFFERENT SCC from being folded into this one.
            let sccMembers = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
            for group in groups {
                for (_, symbol) in group {
                    sccMembers.Add(symbol)
                }
            }
            // Issue #4197: a non-recursive callee reached only from a claimed
            // SCC folds into the same forward-declared group. Folding must
            // stay safe for a member-lifted caller, which has no visibility
            // into this block's function locals: a candidate joins only when every
            // caller of it — computed over the FULL local-function inventory
            // of this block, generic/ref-returning callers included — is
            // itself already inside the group (core member or previously
            // folded). That single "callers ⊆ group" rule also resolves the
            // "reachable from two different claimed SCCs" case for free: such
            // a candidate has a caller outside either group, so it satisfies
            // neither and is left on the existing lift path (never a
            // regression — that is exactly today's behavior).
            let allFunctionPairs = List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]()
            for lf in localFunctionStatements.OfType[LocalFunctionStatementSyntax]() {
                using let modelScope = this.context.UseSemanticModelFor(lf.SyntaxTree)
                if this.context.GetDeclaredSymbol(lf) is IMethodSymbol allSymbol {
                    allFunctionPairs.Add((lf, allSymbol))
                }
            }
            let allSymbols = HashSet[IMethodSymbol](
                allFunctionPairs.Select(
                    (pair(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> pair.Symbol
                ),
                SymbolEqualityComparer.Default
            )
            let callers = Dictionary[IMethodSymbol, HashSet[IMethodSymbol]](SymbolEqualityComparer.Default)
            for (syntax, symbol) in allFunctionPairs {
                using let modelScope = this.context.UseSemanticModelFor(syntax.SyntaxTree)
                for node in syntax.DescendantNodes() {
                    var dependency IMethodSymbol? = this.context.GetSymbolInfo(node).Symbol as IMethodSymbol
                    if dependency != nil && allSymbols.Contains(dependency.OriginalDefinition) &&
                        !SymbolEqualityComparer
                        .Default
                        .Equals(dependency.OriginalDefinition, symbol) {
                        dependency = dependency.OriginalDefinition
                        if !callers.TryGetValue(dependency, out var callerSet) {
                            callerSet = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
                            callers[dependency] = callerSet
                        }
                        callerSet.Add(symbol)
                    }
                }
            }
            let AddGroupMember = func (
                syntax LocalFunctionStatementSyntax,
                symbol IMethodSymbol,
                members List[IMethodSymbol],
                names List[string],
                declarations List[GStatement]
            ) {
                using let modelScope = this.context.UseSemanticModelFor(syntax.SyntaxTree)
                let parameterTypes = List[GTypeReference]()
                for parameter in syntax.ParameterList.Parameters {
                    parameterTypes.Add(this.MapLambdaParameter(parameter).Type)
                }
                let isAsync = syntax.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.AsyncKeyword)
                let returns = List[GTypeReference]()
                if !symbol.ReturnsVoid {
                    let returnType GTypeReference? = this.MapDelegateLikeReturnType(
                        symbol,
                        isAsync,
                        syntax.ReturnType.GetLocation()
                    )
                    if returnType != nil {
                        returns.Add(returnType)
                    }
                }
                let name string? = this.EmittedName(symbol, syntax.Identifier.ValueText)
                members.Add(symbol)
                names.Add(name!!)
                declarations.Add(
                    LocalDeclarationStatement(
                        BindingKind.Var,
                        name,
                        ArrowTypeReference(parameterTypes, returns, isAsync){IsNullable = true},
                        initializer: LiteralExpression.Null()
                    )
                )
            }
            for group in groups {
                // Issue #3501 A2: gsc `let`-bound literals now see their own
                // binding, so a single-member SCC (direct self-recursion) works
                // on the canonical `let name = func …` path even when it
                // captures — no nullable-forward-declaration scheme needed.
                // Only MUTUAL recursion still requires it (a partner would be
                // referenced before its `let` declaration).
                if group.Count == 1 || group.Any(
                    (f(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> excluded.Contains(f.Symbol)
                ) {
                    continue
                }
                // A registering caller may revisit this same statement sequence.
                if group.All(
                    (f(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> this
                        .state
                        .RecursiveLocalFunctionGroups
                        .ContainsKey(f.Symbol)
                ) {
                    continue
                }
                let claimed = HashSet[IMethodSymbol](
                    group.Select((f(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> f.Symbol),
                    SymbolEqualityComparer.Default
                )
                // Fixed-point BFS: a non-recursive candidate joins the fold set
                // once every one of its callers is already claimed (a core SCC
                // member or a previously folded candidate) — this also lets a
                // folded helper's OWN non-recursive callee fold in behind it.
                let foldSet = List[(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)]()
                let foldSymbols = HashSet[IMethodSymbol](SymbolEqualityComparer.Default)
                var grew = true
                while grew {
                    grew = false
                    for (syntax, symbol) in functions {
                        if claimed.Contains(symbol) || excluded.Contains(symbol) || foldSymbols.Contains(symbol) ||
                            sccMembers.Contains(symbol) || this.state.RecursiveLocalFunctionGroups.ContainsKey(symbol) {
                            continue
                        }
                        if !callers.TryGetValue(symbol, out var symbolCallers) ||
                            symbolCallers.Count == 0 ||
                            !symbolCallers.All((c IMethodSymbol) -> claimed.Contains(c) || foldSymbols.Contains(c)) {
                            continue
                        }
                        foldSymbols.Add(symbol)
                        foldSet.Add((syntax, symbol))
                        grew = true
                    }
                }
                let members = List[IMethodSymbol]()
                let names = List[string]()
                let declarations = List[GStatement]()
                for (syntax, symbol) in group {
                    AddGroupMember(syntax, symbol, members, names, declarations)
                }
                for (syntax, symbol) in foldSet.OrderBy(
                    (f(Syntax LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> f.Syntax.SpanStart
                ) {
                    AddGroupMember(syntax, symbol, members, names, declarations)
                }
                for member in members {
                    this
                        .state
                        .RecursiveLocalFunctionGroups[member] = RecursiveLocalFunctionGroup(
                        members,
                        names,
                        declarations
                    )
                }
            }
        }

        // C# local functions are hoisted (callable before their lexical
        // declaration), but G# renders them as `let name = func(...)` bindings,
        // which are NOT hoisted and cannot be forward-referenced (GS0130/GS0125).
        // When a local function is referenced (call, method-group, `+=`/`-=`
        // subscription, argument, ...) before its declaration within a block,
        // move its `let` binding to just before that first use — but no earlier
        // than the last sibling local it captures by closure, since G# `let`
        // bindings require captured locals to already be in scope at the
        // binding point (issue #2231).
        private func HoistCallBeforeDeclLocalFunctions(block BlockSyntax?) IReadOnlyList[
            Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
        ] -> this.HoistCallBeforeDeclLocalFunctions(block!!.Statements, block!!.Span)

        // Issue #2382: the C# top-level-statements entry point has no enclosing
        // `BlockSyntax` (its statements are sibling `GlobalStatementSyntax`
        // members directly under the compilation unit — see
        // <see cref="TranslateTopLevelProgram"/>), so the hoist algorithm is
        // generalized to any flat statement sequence plus the `TextSpan` that
        // bounds "sibling of this sequence" (a real block's own span, or the
        // union span of every top-level statement for the synthesized entry).
        private func HoistCallBeforeDeclLocalFunctions(
            statements IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax],
            enclosingSpan TextSpan
        ) IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax] {
            let localFunctions = statements.OfType[LocalFunctionStatementSyntax]().ToList()
            if localFunctions.Count == 0 {
                return statements
            }
            // (function, anchor index to insert after; null = front of block)
            let toHoist = List[(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)]()
            for localFunction in localFunctions {
                let declIndex = IndexOfReference(statements, localFunction)
                if this.context.GetDeclaredSymbol(localFunction) is not IMethodSymbol funcSymbol {
                    continue
                }
                var firstUseIndex = -1
                for var i = 0; i < declIndex; i++ {
                    let usedHere = statements[i]
                        .DescendantNodes()
                        .OfType[SimpleNameSyntax]()
                        .Any(
                        (id SimpleNameSyntax) -> id
                            .Identifier
                            .ValueText == localFunction
                            .Identifier
                            .ValueText &&
                            SymbolEqualityComparer
                            .Default
                            .Equals(this.context.GetSymbolInfo(id).Symbol?.OriginalDefinition, funcSymbol)
                    )
                    if usedHere {
                        firstUseIndex = i
                        break
                    }
                }
                if firstUseIndex < 0 {
                    // Never referenced ahead of its declaration — leave in place.
                    continue
                }
                let barrierIndex = this.SiblingCaptureBarrierIndex(localFunction, enclosingSpan, statements)
                let anchorIndex = if (barrierIndex != nil) {
                    barrierIndex + 1
                } else {
                    0
                }
                if anchorIndex > firstUseIndex {
                    // The captured sibling local is declared after the first use,
                    // so there is no valid position for the `let` binding — leave
                    // it in place (pre-existing, unrelated ordering conflict).
                    continue
                }
                toHoist.Add((localFunction, declIndex, barrierIndex))
            }
            if toHoist.Count == 0 {
                return statements
            }
            // Issue #3501: a hoisted local function's body may call a sibling
            // local function — the callee's `let` binding must lexically
            // precede the caller's, so every sibling dependency joins the
            // hoist set (carrying the dependent's anchor) and each insertion
            // group is ordered callee-first.
            let functionSymbols = localFunctions
                .Select(
                (f LocalFunctionStatementSyntax) -> (
                    Function: f,
                    Symbol: this.context.GetDeclaredSymbol(f) as IMethodSymbol
                )
            )
                .Where((pair(Function LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> pair.Item2 != nil)
                .ToDictionary(
                func (pair(Function LocalFunctionStatementSyntax, Symbol IMethodSymbol)) LocalFunctionStatementSyntax {
                    return pair.Item1
                },
                (pair(Function LocalFunctionStatementSyntax, Symbol IMethodSymbol)) -> pair.Item2
            )
            let SiblingDependenciesOf = func (function LocalFunctionStatementSyntax) List[
                LocalFunctionStatementSyntax
            ] {
                return function
                    .DescendantNodes()
                    .OfType[SimpleNameSyntax]()
                    .Select((id SimpleNameSyntax) -> this.context.GetSymbolInfo(id).Symbol)
                    .OfType[IMethodSymbol]()
                    .SelectMany(
                    func (symbol IMethodSymbol) IEnumerable[LocalFunctionStatementSyntax] {
                        return functionSymbols.Where(
                            (pair KeyValuePair[LocalFunctionStatementSyntax, IMethodSymbol]) -> !object.ReferenceEquals(
                                pair.Key,
                                function
                            ) &&
                                SymbolEqualityComparer
                                .Default
                                .Equals(pair.Value, symbol.OriginalDefinition)
                        )
                            .Select((pair KeyValuePair[LocalFunctionStatementSyntax, IMethodSymbol]) -> pair.Key)
                    }
                )
                    .Distinct()
                    .ToList()
            }
            var grew = true
            while grew {
                grew = false
                for entry in toHoist.ToList() {
                    for dependency in SiblingDependenciesOf(entry.Function) {
                        if toHoist.Any(
                            (
                                t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)
                            ) -> object.ReferenceEquals(t.Function, dependency)
                        ) {
                            continue
                        }
                        // The dependency's own captures bound how early its
                        // `let` may sit. If its barrier lands AFTER the
                        // dependent's insertion point, hoisting it there would
                        // strand its captured locals — leave BOTH functions in
                        // place instead (the pre-existing ordering-conflict
                        // fallback).
                        let dependencyBarrier = this.SiblingCaptureBarrierIndex(dependency, enclosingSpan, statements)
                        let dependencyAnchor = if (dependencyBarrier != nil) {
                            dependencyBarrier + 1
                        } else {
                            0
                        }
                        let dependentAnchor = if (entry.AnchorIndex != nil) {
                            entry.AnchorIndex!!+ 1
                        } else {
                            0
                        }
                        if dependencyAnchor > dependentAnchor {
                            toHoist.RemoveAll(
                                (
                                    t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)
                                ) -> object.ReferenceEquals(t.Function, entry.Function)
                            )
                            grew = true
                            break
                        }
                        toHoist.Add((dependency, IndexOfReference(statements, dependency), entry.AnchorIndex))
                        grew = true
                    }
                }
            }
            let hoistSet = HashSet[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax](
                toHoist.Select(
                    (t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)) -> cast[
                        Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
                    ](t.Function)
                )
            )
            let reordered = statements.Where(
                (s Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) -> !hoistSet.Contains(s)
            )
                .ToList()
            // Group by anchor statement (the sibling local's declaring statement,
            // or the front of the block) and re-insert each group, ordered
            // callee-first (stable by original declaration order otherwise).
            for group in toHoist.OrderBy(
                (t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)) -> t.DeclIndex
            )
                .GroupBy(
                (t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)) -> if (
                    t.AnchorIndex != nil
                ) {
                    statements[t.AnchorIndex!!]
                } else {
                    default(Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax?)
                }
            ) {
                let members = group.Select(
                    (t(Function LocalFunctionStatementSyntax, DeclIndex int32, AnchorIndex int32?)) -> t.Function
                )
                    .ToList()
                let placed = List[LocalFunctionStatementSyntax]()
                let remaining = List[LocalFunctionStatementSyntax](members)
                while remaining.Count > 0 {
                    let next = remaining.FirstOrDefault(
                        (candidate LocalFunctionStatementSyntax) -> !SiblingDependenciesOf(candidate).Any(
                            (dep LocalFunctionStatementSyntax) -> remaining.Contains(dep) && !object.ReferenceEquals(
                                dep,
                                candidate
                            )
                        )
                    ) ??
                        remaining[0]
                    remaining.Remove(next)
                    placed.Add(next)
                }
                let insertAt = if group.Key == nil {
                    0
                } else {
                    reordered.IndexOf(group.Key!!) + 1
                }
                reordered.InsertRange(insertAt, placed.Cast[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]())
            }
            return reordered
        }

        // Returns the index (within `statements`) of the last statement that
        // declares a local variable captured by `localFunction` from the
        // enclosing block — the `let` binding must not be hoisted above this
        // point. Returns null when no sibling local is captured (references to
        // the enclosing method's parameters, outer-scope locals, or the
        // function's own locals/parameters don't count — those remain in scope
        // at the front of the block).
        private func SiblingCaptureBarrierIndex(
            localFunction LocalFunctionStatementSyntax,
            enclosingSpan TextSpan,
            statements IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax]
        ) int32? {
            var barrier int32? = nil
            for id in localFunction.DescendantNodes().OfType[IdentifierNameSyntax]() {
                if this.context.GetSymbolInfo(id).Symbol is not ILocalSymbol local {
                    continue
                }
                for reference in local.DeclaringSyntaxReferences {
                    let declaration = reference.GetSyntax()
                    // A local declared inside the function's own body is safe.
                    if localFunction.Span.Contains(declaration.Span) {
                        continue
                    }
                    // Not a sibling of this block (e.g. an outer-scope local) —
                    // already in scope wherever the `let` binding lands.
                    if !enclosingSpan.Contains(declaration.Span) {
                        continue
                    }
                    for var i = 0; i < statements.Count; i++ {
                        if statements[i].Span.Contains(declaration.Span) && (barrier == nil || i > barrier) {
                            barrier = i
                        }
                    }
                }
            }
            return barrier
        }

        private func TranslateFixedStatement(
            node Microsoft.CodeAnalysis.CSharp.Syntax.FixedStatementSyntax
        ) IEnumerable[GStatement] {
            // Translate the innermost body once; multiple declarators nest as
            // successive `fixed` blocks (`fixed a … { fixed b … { body } }`).
            var body = this.TranslateStatementAsBlock(node.Statement)
            let declaration = node.Declaration
            let pointerType GTypeReference? = this.MapTypeSyntax(declaration.Type)
            for var i = declaration.Variables.Count - 1; i >= 0; i-- {
                let declarator = declaration.Variables[i]
                // Issue #4378 (ADR-0125 amendment): a C# fixed-size buffer
                // source (`fixed (sbyte* p = Name)`) translates to the same
                // G# `fixed p *int8 = this.Name { … }` form as any other pin
                // source — gsc pins the buffer's containing storage for the
                // block, exactly as C# does.
                let source GExpression? = if declarator.Initializer != nil {
                    this.TranslateExpression(declarator.Initializer!!.Value)
                } else {
                    cast[GExpression](IdentifierExpression("nil"))
                }
                body = BlockStatement(
                    []GStatement{
                        FixedStatement(this.EmittedName(declarator, declarator.Identifier), pointerType, source, body)
                    }
                )
            }
            // Unwrap the single outer wrapper block so the caller receives the
            // `fixed` statement(s) directly.
            return body.Statements
        }

        private func TranslateStatementAsBlock(
            statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
        ) BlockStatement {
            if statement is BlockSyntax block {
                return this.TranslateBlock(block)
            }
            return BlockStatement(this.TranslateStatement(statement).ToList())
        }

        // Issue #3501 B3: comments between a block's last statement and its
        // closing brace have no following statement to ride on; emit them as
        // standalone comment lines so they survive.
        private func AppendDanglingComments(
            statements List[GStatement],
            closeBrace Microsoft.CodeAnalysis.SyntaxToken
        ) {
            for trivia in closeBrace.LeadingTrivia {
                switch trivia.Kind() {
                    case Microsoft.CodeAnalysis.CSharp.SyntaxKind.SingleLineCommentTrivia {
                        statements.Add(RawStatement(trivia.ToString().TrimEnd()))
                    }
                    case Microsoft.CodeAnalysis.CSharp.SyntaxKind.MultiLineCommentTrivia {
                        var block = trivia.ToString()
                        block = if block.StartsWith("/*", StringComparison.Ordinal) {
                            block.Substring(2)
                        } else {
                            block
                        }
                        block = if block.EndsWith("*/", StringComparison.Ordinal) {
                            block.Substring(0, block.Length - 2)
                        } else {
                            block
                        }
                        for raw in block.Split('\n') {
                            let text = raw.Trim().TrimStart('*').TrimStart()
                            statements.Add(
                                RawStatement(
                                    if text.Length == 0 {
                                        "//"
                                    } else {
                                        "// $text"
                                    }
                                )
                            )
                        }
                    }
                    default {
                        let _ = 0
                    }
                }
            }
        }

        private func TranslateStatement(statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) IEnumerable[
            GStatement
        ] {
            let outerSpillPrologue List[GStatement]? = this.state.PendingSpillPrologue
            let outerOutDeclarations List[GStatement]? = this.state.FunctionArgumentOutDeclarations
            let outerSuppressions HashSet[string]? = this.state.PendingStatementSuppressions
            let spillPrologue = List[GStatement]()
            let suppressions = HashSet[string](StringComparer.Ordinal)
            this.state.PendingSpillPrologue = spillPrologue
            this.state.FunctionArgumentOutDeclarations = spillPrologue
            this.state.PendingStatementSuppressions = suppressions
            try {
                let core = this.TranslateStatementCore(statement)!!.ToList()
                if spillPrologue.Count == 0 {
                    AttachSourceComments(core.FirstOrDefault(), statement)
                    this.SanitizeDocParamComments(core.FirstOrDefault(), statement)
                    AttachTrailingComment(core.LastOrDefault(), statement)
                    return ApplyStatementSuppressions(
                        core,
                        if DeclaresVariableVisibleAfter(statement) {
                            default(HashSet[string]?)
                        } else {
                            suppressions
                        }
                    )
                }
                let combined = List[GStatement](spillPrologue)
                combined.AddRange(core)
                AttachSourceComments(combined[0], statement)
                this.SanitizeDocParamComments(combined[0], statement)
                AttachTrailingComment(combined[^1], statement)
                return ApplyStatementSuppressions(
                    combined,
                    if DeclaresVariableVisibleAfter(statement) {
                        default(HashSet[string]?)
                    } else {
                        suppressions
                    }
                )
            } finally {
                this.state.PendingSpillPrologue = outerSpillPrologue
                this.state.FunctionArgumentOutDeclarations = outerOutDeclarations
                this.state.PendingStatementSuppressions = outerSuppressions
            }
        }

        private func TranslateStatementCore(statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) IEnumerable[
            GStatement
        ]? {
            switch statement {
                case local is LocalDeclarationStatementSyntax {
                    return this.TranslateLocalDeclaration(
                        local.Declaration,
                        local.IsConst,
                        isUsing: local.UsingKeyword != default(Microsoft.CodeAnalysis.SyntaxToken),
                        isAwait: !local.AwaitKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.None)
                    )
                }
                case expressionStatement is Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionStatementSyntax {
                    // ADR-0143 §D rule 1: an expression statement whose
                    // invocation binds to an ELIDED unimplemented partial method
                    // is dropped. A deletable C# partial method is necessarily
                    // `void` with no `out` parameters and is only ever invoked in
                    // statement position (MVVM's `OnFooChanged(...)`), so dropping
                    // the whole statement is safe and complete.
                    if this.IsElidedPartialMethodInvocation(expressionStatement.Expression) {
                        return Array.Empty[GStatement]()
                    }
                    return this.TranslateExpressionStatements(expressionStatement.Expression)
                }
                case breakStatement is Microsoft.CodeAnalysis.CSharp.Syntax.BreakStatementSyntax {
                    return this.TranslateBreakStatement(breakStatement)
                }
                case Microsoft.CodeAnalysis.CSharp.Syntax.ContinueStatementSyntax {
                    return []GStatement{cast[GStatement](ContinueStatement())}
                }
                case labeledStatement is Microsoft.CodeAnalysis.CSharp.Syntax.LabeledStatementSyntax {
                    return this.TranslateLabeledStatement(labeledStatement)
                }
                case gotoStatement is Microsoft.CodeAnalysis.CSharp.Syntax.GotoStatementSyntax {
                    return this.TranslateGotoStatement(gotoStatement)
                }
                case doStatement is DoStatementSyntax {
                    if this.TryTranslateLoopWithConditionHoist(
                        doStatement.Condition,
                        doStatement.Statement,
                        isDoWhile: true,
                        out var doHoisted
                    ) {
                        return doHoisted
                    }
                    return []GStatement{
                        cast[GStatement](
                            DoWhileStatement(
                                this.TranslateStatementAsBlock(doStatement.Statement),
                                this.TranslateExpression(doStatement.Condition)
                            )
                        )
                    }
                }
                case lockStatement is Microsoft.CodeAnalysis.CSharp.Syntax.LockStatementSyntax {
                    return []GStatement{this.TranslateLock(lockStatement)}
                }
                case localFunction is LocalFunctionStatementSyntax {
                    return this.TranslateLocalFunction(localFunction)
                }
                case checkedStatement is CheckedStatementSyntax {
                    // Issue #1881: a C# `checked { }`/`unchecked { }` block maps to
                    // the G# `checked { }`/`unchecked { }` block (gsc now supports
                    // both natively), introducing a checked/unchecked arithmetic
                    // context instead of silently dropping the overflow semantics.
                    return []GStatement{
                        cast[GStatement](
                            BlockStatement(
                                this.TranslateBlock(checkedStatement.Block).Statements,
                                isChecked: checkedStatement.IsKind(
                                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.CheckedStatement
                                ),
                                isUnchecked: checkedStatement.IsKind(
                                    Microsoft.CodeAnalysis.CSharp.SyntaxKind.UncheckedStatement
                                )
                            )
                        )
                    }
                }
                case unsafeStatement is UnsafeStatementSyntax {
                    // ADR-0122 / issue #1014: a C# `unsafe { … }` block maps to the
                    // G# `unsafe { … }` block, introducing an unsafe context.
                    return []GStatement{
                        cast[GStatement](
                            BlockStatement(this.TranslateBlock(unsafeStatement.Block).Statements, isUnsafe: true)
                        )
                    }
                }
                case fixedStatement is Microsoft.CodeAnalysis.CSharp.Syntax.FixedStatementSyntax {
                    // gsc issue #1026: a C# `fixed (T* p = src) { … }` pins a managed
                    // array/string and exposes a raw pointer, mapping to the G#
                    // `fixed p *T = src { … }` form (only legal inside `unsafe`).
                    return this.TranslateFixedStatement(fixedStatement)
                }
                case ret is Microsoft.CodeAnalysis.CSharp.Syntax.ReturnStatementSyntax {
                    {
                        if ret.Expression == nil {
                            return []GStatement{cast[GStatement](ReturnStatement(nil))}
                        }
                        // Only a value-position deconstruction assignment needs a
                        // return prologue; ordinary assignments remain inline.
                        let returnPrologue = List[GStatement]()
                        let replacements = List[Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax]()
                        let returnEmbedded = this.HoistAssignmentsInOrder(
                            ret.Expression,
                            includeSelf: true,
                            returnPrologue,
                            replacements
                        )
                        var returnValue GExpression?
                        try {
                            returnValue = this.TranslateValueWithNullForgiveness(ret.Expression)
                        } finally {
                            this.ReleaseHoistedAssignments(returnEmbedded, replacements)
                        }
                        returnPrologue.Add(
                            ReturnStatement(
                                this.CoerceCovariantArrayConversion(
                                    ret.Expression,
                                    this.CoercePointerConversion(ret.Expression, returnValue)
                                ),
                                isRef: ret.Expression is RefExpressionSyntax
                            )
                        )
                        return returnPrologue
                    }
                }
                case ifStatement is Microsoft.CodeAnalysis.CSharp.Syntax.IfStatementSyntax {
                    return this.TranslateIfStatements(ifStatement)!!.ToArray()
                }
                case whileStatement is Microsoft.CodeAnalysis.CSharp.Syntax.WhileStatementSyntax {
                    if this.TryTranslateLoopWithConditionHoist(
                        whileStatement.Condition,
                        whileStatement.Statement,
                        isDoWhile: false,
                        out var whileHoisted
                    ) {
                        return whileHoisted
                    }
                    return []GStatement{
                        cast[GStatement](
                            WhileStatement(
                                GuardBlockCondition(this.TranslateExpression(whileStatement.Condition)!!),
                                this.TranslateStatementAsBlock(whileStatement.Statement)
                            )
                        )
                    }
                }
                case forStatement is ForStatementSyntax {
                    return []GStatement{this.TranslateForStatement(forStatement)}
                }
                case forEach is ForEachStatementSyntax {
                    // The iterable receiver gets the same nullable-narrowing `!!`
                    // treatment as a member/element-access receiver: a declared-
                    // nullable (or #1072-promoted) field/property iterated inside a
                    // null guard is flow-proven non-null in C#, but G# smart-casts
                    // narrow only locals, so `for x in field` over a `T?` field is
                    // rejected (GS0116 "not indexable") without an explicit
                    // `field!!`.
                    //
                    // A C# `await foreach` carries a non-empty `await` keyword; it
                    // lowers to G#'s async-iteration form `await for x in seq`
                    // (spec AwaitForRangeStmt). Without it, iterating an
                    // `IAsyncEnumerable<T>` with a plain `for` is rejected (GS0116).
                    let loopSymbol ISymbol? = this.context.GetDeclaredSymbol(forEach)
                    let loopIdentifier string? = this.EmittedName(loopSymbol, forEach.Identifier.ValueText)
                    let forEachInfo = this.context.SemanticModel.GetForEachStatementInfo(forEach)
                    let projectedElement ITypeSymbol? = this.GetProjectedForEachElementType(forEach, forEachInfo)
                    let declaredBindingType ITypeSymbol? = this.context.GetTypeInfo(forEach.Type).Type
                    let forEachElement ITypeSymbol? = this.GetProjectedBindingType(
                        projectedElement,
                        declaredBindingType,
                        forEachInfo.ElementConversion
                    ) ??
                        declaredBindingType
                    let projectedBindingType = forEachElement != nil &&
                        projectedElement != nil &&
                        (
                        forEachInfo.ElementConversion.IsIdentity || !SymbolEqualityComparer.IncludeNullability.Equals(
                            forEachElement,
                            declaredBindingType
                        )
                    )
                    let nullableElement = (
                        projectedBindingType &&
                            (
                            this.ArrayExpressionHasNullableReferenceLikeElement(forEach.Expression) ||
                                (
                                this.IsReferenceLikeOrManagedReference(forEachElement) &&
                                    forEachElement!!.NullableAnnotation == Microsoft
                                    .CodeAnalysis
                                    .NullableAnnotation
                                    .Annotated
                            )
                        )
                    ) ||
                        this.ForEachIteratesPromotedSourceIteratorElement(forEach, forEachInfo)
                    let projectedLoopLocal ILocalSymbol? = if projectedBindingType {
                        loopSymbol as ILocalSymbol
                    } else {
                        default(ILocalSymbol?)
                    }
                    let projectedBinding = projectedLoopLocal != nil &&
                        forEachElement != nil &&
                        !SymbolEqualityComparer
                        .IncludeNullability
                        .Equals(projectedLoopLocal.Type, forEachElement)
                    if projectedBinding {
                        this
                            .state
                            .ManagedReferenceArrayNullable
                            .ManagedReferenceArrayProjectedLocalType[projectedLoopLocal!!] = forEachElement
                    }
                    if nullableElement && loopSymbol != nil {
                        this.state.NullableForEachBindings.Add(loopSymbol)
                    }
                    var loopBody BlockStatement
                    try {
                        loopBody = this.TranslateStatementAsBlock(forEach.Statement)
                    } finally {
                        if nullableElement && loopSymbol != nil {
                            this.state.NullableForEachBindings.Remove(loopSymbol)
                        }
                        if projectedBinding {
                            this
                                .state
                                .ManagedReferenceArrayNullable
                                .ManagedReferenceArrayProjectedLocalType
                                .Remove(projectedLoopLocal!!)
                        }
                    }
                    // Issue #3935: an IDENTITY element conversion means the
                    // declared type IS the sequence's element type, so a typed
                    // range clause (#3925) adds no information — and it actively
                    // LOSES information, because the type comes from the loop's
                    // type SYNTAX and so never passes through the oblivious
                    // null-taint promotion every other declaration sink uses.
                    // `foreach ((string Path, byte[] Original) t in props)` then
                    // re-spelled an element the analysis had promoted to
                    // `([]uint8)?` everywhere else as a bare `[]uint8`, and the
                    // live `t.Original == null` guard folded into GS0523. Omitting
                    // the redundant annotation lets G# infer the promoted element
                    // type. A real element conversion still emits its type, which
                    // is what #3925 replaced `__foreachN` synthesis with.
                    var loopVariableType GTypeReference? = nil
                    if !forEach.Type.IsVar && !forEachInfo.ElementConversion.IsIdentity {
                        let targetSymbol ITypeSymbol? = forEachElement ?? this.context.GetTypeInfo(forEach.Type).Type
                        loopVariableType = if targetSymbol != nil {
                            this.typeMapper.Map(targetSymbol, this.context, forEach.Type.GetLocation())
                        } else {
                            cast[GTypeReference](NamedTypeReference(forEach.Type.ToString()))
                        }
                        loopVariableType = this.PromoteIfUsedAsNullable(
                            loopVariableType,
                            this.context.GetDeclaredSymbol(forEach)
                        )
                    }
                    return []GStatement{
                        cast[GStatement](
                            ForInStatement(
                                loopIdentifier,
                                this.TranslateReceiverWithNullForgiveness(forEach.Expression),
                                loopBody,
                                isAwait: !forEach.AwaitKeyword.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.None),
                                variableType: loopVariableType
                            )
                        )
                    }
                }
                case forEachVariable is ForEachVariableStatementSyntax {
                    return []GStatement{this.TranslateForEachVariable(forEachVariable)}
                }
                case throwStatement is Microsoft.CodeAnalysis.CSharp.Syntax.ThrowStatementSyntax {
                    return []GStatement{this.TranslateThrow(throwStatement)}
                }
                case tryStatement is Microsoft.CodeAnalysis.CSharp.Syntax.TryStatementSyntax {
                    return []GStatement{this.TranslateTry(tryStatement)}
                }
                case usingStatement is Microsoft.CodeAnalysis.CSharp.Syntax.UsingStatementSyntax {
                    return []GStatement{this.TranslateUsingStatement(usingStatement)}
                }
                case block is BlockSyntax {
                    return []GStatement{cast[GStatement](this.TranslateBlock(block))}
                }
                case switchStatement is Microsoft.CodeAnalysis.CSharp.Syntax.SwitchStatementSyntax {
                    return this.TranslateSwitchStatement(switchStatement)
                }
                case yieldStatement is Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax {
                    return this.TranslateYieldStatement(yieldStatement)
                }
                case EmptyStatementSyntax {
                    return Array.Empty[GStatement]()
                }
                default {
                    this.context.ReportUnsupported(
                        statement,
                        "statement '${statement.Kind()}' has no canonical G# form yet; emitted a placeholder comment (ADR-0115 §B)."
                    )
                    return []GStatement{cast[GStatement](RawStatement("// unsupported: ${statement.Kind()}"))}
                }
            }
        }

        private func GetProjectedForEachElementType(
            forEach CommonForEachStatementSyntax,
            forEachInfo ForEachStatementInfo
        ) ITypeSymbol? {
            if forEachInfo.ElementConversion.IsIdentity && this.GetMappedArrayElementType(
                forEach.Expression
            ) is {} mappedArrayElement {
                return mappedArrayElement
            }
            let projectedCollection ITypeSymbol? = this.GetManagedReferenceArrayProjectedExpressionType(
                forEach.Expression
            )
            if !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                projectedCollection,
                this.context.Compilation
            ) {
                return nil
            }
            if projectedCollection is INamedTypeSymbol projectedNamed {
                if forEachInfo.GetEnumeratorMethod is {} getEnumerator && this.GetProjectedMember(
                    projectedNamed,
                    getEnumerator
                ) is IMethodSymbol projectedGetEnumerator &&
                    projectedGetEnumerator.ReturnType is INamedTypeSymbol projectedEnumerator &&
                    forEachInfo.CurrentProperty is {} current &&
                    this.GetProjectedMember(projectedEnumerator, current) is IPropertySymbol projectedCurrent {
                    return projectedCurrent.Type
                }
            }
            return GetEnumerableElementType(projectedCollection, forEach.AwaitKeyword.RawKind != 0)
        }

        private func GetProjectedBindingType(
            projectedSource ITypeSymbol?,
            destination ITypeSymbol?,
            conversion Conversion
        ) ITypeSymbol? {
            if projectedSource == nil || destination == nil {
                return nil
            }
            if !CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                projectedSource,
                this.context.Compilation
            ) {
                return nil
            }
            if conversion.IsIdentity {
                return projectedSource
            }
            if !conversion.IsImplicit || conversion.MethodSymbol != nil {
                return nil
            }
            if projectedSource is INamedTypeSymbol{IsTupleType: true} sourceTuple &&
                destination is INamedTypeSymbol{IsTupleType: true} destinationTuple &&
                sourceTuple
                .TupleElements
                .Length == destinationTuple
                .TupleElements
                .Length {
                let arguments = ImmutableArray.CreateBuilder[ITypeSymbol](sourceTuple.TupleElements.Length)
                let annotations = ImmutableArray.CreateBuilder[Microsoft.CodeAnalysis.NullableAnnotation](
                    sourceTuple.TupleElements.Length
                )
                for var i = 0; i < sourceTuple.TupleElements.Length; i++ {
                    let sourceElement = GetEffectiveTupleElementType(sourceTuple, i)
                    let destinationElement = GetEffectiveTupleElementType(destinationTuple, i)
                    var projectedElement ITypeSymbol? = this.GetProjectedBindingType(
                        sourceElement,
                        destinationElement,
                        this.context.Compilation.ClassifyConversion(sourceElement, destinationElement)
                    )
                    if projectedElement == nil {
                        if CSharpToGSharpTranslator.TypeContainsRecognizedManagedReferenceConsumer(
                            sourceElement,
                            this.context.Compilation
                        ) {
                            return nil
                        }
                        projectedElement = destinationElement
                    }
                    arguments.Add(projectedElement)
                    annotations.Add(projectedElement.NullableAnnotation)
                }
                return this
                    .context
                    .Compilation
                    .CreateTupleTypeSymbol(
                    arguments.ToImmutable(),
                    destinationTuple.TupleElements.Select((element IFieldSymbol) -> element.Name).ToImmutableArray(),
                    default(ImmutableArray[Location?]),
                    annotations.ToImmutable()
                )
            }
            if !conversion.IsReference {
                return nil
            }
            return if projectedSource.NullableAnnotation == Microsoft
                .CodeAnalysis
                .NullableAnnotation
                .Annotated &&
                this
                .IsReferenceLikeOrManagedReference(projectedSource) {
                destination.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.Annotated)
            } else {
                destination
            }
        }

        shared {
            // ADR-0184: the CLR identity of `[UnscopedRef]`, matched by full name
            // so an alias or a `using static` spelling still resolves.
            private const UnscopedRefAttributeFullName string = "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute"

            // Issue #3469: author comments (`//`, `/* */`, and `///` doc lines)
            // from the C# node's leading trivia are carried onto the first G#
            // node the construct translates to; the printer re-emits them above
            // that node. Block comments normalize to `//` lines; doc-comment
            // lines keep the `///` marker (G# doc comments, ADR-0057). Synthesized
            // translator notes stay distinguishable because they are RawStatement
            // text, never AttachedComments entries.
            internal func AttachSourceComments(node GNode?, source Microsoft.CodeAnalysis.SyntaxNode?) {
                if node == nil || source == nil {
                    return
                }
                // The file header belongs to the compilation unit (FileHeader),
                // not to the first declaration, even when it is in that
                // declaration's leading trivia.
                var header = default(TextSpan)
                let hasHeader = source.FullSpan.Start == 0 && source.SyntaxTree?.GetRoot() is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .CompilationUnitSyntax root &&
                    FileHeader.TryGetSpan(root, out header)
                var lines List[string]? = nil
                for trivia in source.GetLeadingTrivia() {
                    if hasHeader && header.Contains(trivia.Span) {
                        continue
                    }
                    switch trivia.Kind() {
                        case Microsoft.CodeAnalysis.CSharp.SyntaxKind.SingleLineCommentTrivia {
                            (
                                (
                                    if lines == nil {
                                        (lines = List[string]())
                                    } else {
                                        lines
                                    }
                                )!!
                            ).Add(trivia.ToString().TrimEnd())
                        }
                        case Microsoft.CodeAnalysis.CSharp.SyntaxKind.MultiLineCommentTrivia {
                            var block = trivia.ToString()
                            block = if block.StartsWith("/*", StringComparison.Ordinal) {
                                block.Substring(2)
                            } else {
                                block
                            }
                            block = if block.EndsWith("*/", StringComparison.Ordinal) {
                                block.Substring(0, block.Length - 2)
                            } else {
                                block
                            }
                            for raw in block.Split('\n') {
                                let text = raw.Trim().TrimStart('*').TrimStart()
                                (
                                    (
                                        if lines == nil {
                                            (lines = List[string]())
                                        } else {
                                            lines
                                        }
                                    )!!
                                )
                                    .Add(
                                    if text.Length == 0 {
                                        "//"
                                    } else {
                                        "// $text"
                                    }
                                )
                            }
                        }
                        case Microsoft.CodeAnalysis.CSharp.SyntaxKind.SingleLineDocumentationCommentTrivia {
                            // Issue #3501 B1: XML doc comments convert to the
                            // ADR-0057 Markdown authoring surface (`@param`,
                            // backticks, `(cref:X)`, …) with the ```xmldoc
                            // escape hatch for constructs outside the bijective
                            // subset; malformed XML passes through verbatim.
                            let converted IReadOnlyList[string]? = XmlDocMarkdownConverter.Convert(
                                trivia.ToFullString()
                            )
                            if converted != nil {
                                (
                                    (
                                        if lines == nil {
                                            (lines = List[string]())
                                        } else {
                                            lines
                                        }
                                    )!!
                                ).AddRange(converted)
                            }
                        }
                        default {
                            let _ = 0
                        }
                    }
                }
                if lines == nil {
                    return
                }
                // Issue #3501 (GS0227): a static initializer block is not a
                // documentable declaration in G# — a C# static constructor's doc
                // comment downgrades to a regular comment.
                if node is StaticInitializerBlock && lines.Any(
                    (l string) -> l.StartsWith("///", StringComparison.Ordinal)
                ) {
                    lines = lines.Select(
                        (l string) -> if l.StartsWith("///", StringComparison.Ordinal) {
                            "//" + l.Substring(3)
                        } else {
                            l
                        }
                    )
                        .ToList()
                }
                // Issue #3501 (GS0227): C# tolerates an ordinary comment BETWEEN
                // a doc comment and its declaration; gsc requires the `///` block
                // to be adjacent. Partition so regular comments print first and
                // the doc block hugs the declaration.
                if lines!!.Any((l string) -> l.StartsWith("///", StringComparison.Ordinal)) && lines!!.Any(
                    (l string) -> !l.StartsWith("///", StringComparison.Ordinal)
                ) {
                    lines = lines!!
                        .Where((l string) -> !l.StartsWith("///", StringComparison.Ordinal))
                        .Concat(lines!!.Where((l string) -> l.StartsWith("///", StringComparison.Ordinal)))
                        .ToList()
                }
                node.AttachedComments = if node.AttachedComments is {Count: > 0} existing {
                    lines!!.Concat(existing).ToList()
                } else {
                    lines
                }
            }

            private func IsTrivialConstructorInitializerArgument(
                expression Microsoft.CodeAnalysis.CSharp.Syntax.ExpressionSyntax
            ) bool {
                var expression = expression
                while expression is Microsoft.CodeAnalysis.CSharp.Syntax.ParenthesizedExpressionSyntax parenthesized {
                    expression = parenthesized.Expression
                }
                return expression is IdentifierNameSyntax ||
                    expression is ThisExpressionSyntax ||
                    expression is BaseExpressionSyntax ||
                    expression is Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .LiteralExpressionSyntax
            }

            private func IsIteratorBody(node MethodDeclarationSyntax?) bool {
                let body Microsoft
                    .CodeAnalysis
                    .SyntaxNode? = cast[Microsoft.CodeAnalysis.SyntaxNode](node!!.Body) ??
                    node!!.ExpressionBody
                if body == nil {
                    return false
                }
                // A `yield` inside a nested local function belongs to that function, not
                // to this method, so descendants under a local-function boundary are
                // excluded from the iterator test.
                return body
                    .DescendantNodes((n Microsoft.CodeAnalysis.SyntaxNode) -> !(n is LocalFunctionStatementSyntax))
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax]()
                    .Any()
            }

            private func IsIteratorBody(node LocalFunctionStatementSyntax) bool {
                let body Microsoft
                    .CodeAnalysis
                    .SyntaxNode? = cast[Microsoft.CodeAnalysis.SyntaxNode](node.Body) ??
                    node.ExpressionBody
                return body
                    ?.DescendantNodes((n Microsoft.CodeAnalysis.SyntaxNode) -> !(n is LocalFunctionStatementSyntax))
                    .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.YieldStatementSyntax]()
                    .Any() == true
            }

            private func CountTranslatedControlTransferReferences(
                statement GStatement?,
                counts IDictionary[GStatement, int32]
            ) {
                switch statement {
                    case nil {
                        return
                    }
                    case ReturnStatement, ThrowStatement, RethrowStatement {
                        counts.TryGetValue(statement!!, out var count)
                        counts[statement!!] = count + 1
                        return
                    }
                    case block is BlockStatement {
                        for child in block.Statements {
                            CountTranslatedControlTransferReferences(child, counts)
                        }
                        return
                    }
                    case conditional is IfStatement {
                        CountTranslatedControlTransferReferences(conditional.Then, counts)
                        CountTranslatedControlTransferReferences(conditional.ElseBranch, counts)
                        return
                    }
                    case ifLet is IfLetStatement {
                        CountTranslatedControlTransferReferences(ifLet.Then, counts)
                        CountTranslatedControlTransferReferences(ifLet.Else, counts)
                        return
                    }
                    case loop is WhileStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case loop is WhileLetStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case loop is DoWhileStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case loop is ForStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case loop is ForInStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case loop is ForTupleInStatement {
                        CountTranslatedControlTransferReferences(loop.Body, counts)
                        return
                    }
                    case locked is LockStatement {
                        CountTranslatedControlTransferReferences(locked.Body, counts)
                        return
                    }
                    case fixedStatement is FixedStatement {
                        CountTranslatedControlTransferReferences(fixedStatement.Body, counts)
                        return
                    }
                    case tryStatement is TryStatement {
                        CountTranslatedControlTransferReferences(tryStatement.TryBlock, counts)
                        for catchClause in tryStatement.CatchClauses {
                            CountTranslatedControlTransferReferences(catchClause.Body, counts)
                        }
                        CountTranslatedControlTransferReferences(tryStatement.FinallyBlock, counts)
                        return
                    }
                    case switchStatement is SwitchStatement {
                        for switchCase in switchStatement.Cases {
                            CountTranslatedControlTransferReferences(switchCase.Body, counts)
                        }
                        return
                    }
                    case labeled is LabeledStatement {
                        CountTranslatedControlTransferReferences(labeled.Statement, counts)
                        return
                    }
                    default {
                        return
                    }
                }
            }

            private func IsLiftedHelperOccupiedNameDeclaration(
                node Microsoft.CodeAnalysis.SyntaxNode
            ) bool -> node is VariableDeclaratorSyntax ||
                node is VariableDesignationSyntax ||
                node is Microsoft
                .CodeAnalysis
                .CSharp
                .Syntax
                .ParameterSyntax ||
                node is LocalFunctionStatementSyntax ||
                node is ForEachStatementSyntax ||
                node is CatchDeclarationSyntax ||
                node is FromClauseSyntax ||
                node is LetClauseSyntax ||
                node is JoinClauseSyntax ||
                node is JoinIntoClauseSyntax ||
                node is QueryContinuationSyntax

            // Identifier spelling -> matching tokens, built once per compilation
            // so lifted-helper candidates never rescan syntax trees.
            private func GetIdentifierTokens(compilation Compilation, name string) IReadOnlyList[
                Microsoft.CodeAnalysis.SyntaxToken
            ] {
                let index = CSharpToGSharpTranslator.IdentifierTokenIndexes.GetValue(
                    compilation,
                    (target Compilation) -> {
                        let built = Dictionary[string, List[Microsoft.CodeAnalysis.SyntaxToken]](StringComparer.Ordinal)
                        for tree in target.SyntaxTrees {
                            for token in tree.GetRoot().DescendantTokens() {
                                if token.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.IdentifierToken) {
                                    if !built.TryGetValue(token.ValueText, out var tokens) {
                                        tokens = List[Microsoft.CodeAnalysis.SyntaxToken]()
                                        built.Add(token.ValueText, tokens)
                                    }
                                    tokens.Add(token)
                                }
                            }
                        }
                        return built
                    }
                )
                return if index.TryGetValue(name, out var found) {
                    cast[IReadOnlyList[Microsoft.CodeAnalysis.SyntaxToken]](found)
                } else {
                    cast[IReadOnlyList[Microsoft.CodeAnalysis.SyntaxToken]](
                        Array.Empty[Microsoft.CodeAnalysis.SyntaxToken]()
                    )
                }
            }

            private func ContainsToken(
                references List[SyntaxReference],
                token Microsoft.CodeAnalysis.SyntaxToken
            ) bool -> references.Any(
                (reference SyntaxReference) -> reference.SyntaxTree == token.SyntaxTree && reference.Span.Contains(
                    token.Span
                )
            )

            private func IsTypeRelatedToLiftedHelperOwners(
                type INamedTypeSymbol?,
                owners HashSet[INamedTypeSymbol]
            ) bool {
                let definition = type!!.OriginalDefinition
                for owner in owners {
                    for var current INamedTypeSymbol? = definition;
                        current != nil;
                        current = current!!
                        .BaseType
                        ?.OriginalDefinition {
                        if SymbolEqualityComparer.Default.Equals(current, owner) {
                            return true
                        }
                    }
                    for var current INamedTypeSymbol? = owner;
                        current != nil;
                        current = current!!
                        .BaseType
                        ?.OriginalDefinition {
                        if SymbolEqualityComparer.Default.Equals(current, definition) {
                            return true
                        }
                    }
                    if owner.AllInterfaces.Any(
                        (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                            candidate.OriginalDefinition,
                            definition
                        )
                    ) ||
                        definition
                        .AllInterfaces
                        .Any(
                        (candidate INamedTypeSymbol) -> SymbolEqualityComparer.Default.Equals(
                            candidate.OriginalDefinition,
                            owner
                        )
                    ) {
                        return true
                    }
                }
                return false
            }

            private func GetLocalFunctionSiblingStatements(localFunction LocalFunctionStatementSyntax) IEnumerable[
                Microsoft.CodeAnalysis.SyntaxNode
            ] -> switch localFunction
                .Parent {
                case block is BlockSyntax: block.Statements
                case section is SwitchSectionSyntax: section.Statements
                case Microsoft
                    .CodeAnalysis
                    .CSharp
                    .Syntax
                    .GlobalStatementSyntax{
                    Parent: Microsoft.CodeAnalysis.CSharp.Syntax.CompilationUnitSyntax unit
                }: cast[IEnumerable[Microsoft.CodeAnalysis.SyntaxNode]](
                    unit
                        .Members
                        .OfType[Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax]()
                        .Select(
                        (statement Microsoft.CodeAnalysis.CSharp.Syntax.GlobalStatementSyntax) -> statement.Statement
                    )
                )
                default: Enumerable.Repeat[Microsoft.CodeAnalysis.SyntaxNode](localFunction, 1)
            }

            // Issue #1278 / ADR-0131: a C# expression-bodied member (`=> expr`)
            // translates to the idiomatic G# arrow form (`-> expr`) when the
            // translated body folds to a single, inline-renderable statement. A
            // value-returning body is `{ return expr }`; a void body is a single
            // expression or assignment statement. Bodies that needed extra
            // statements (parameter shadows, hoisted temporaries, a bare `throw`
            // expression, or an `unsafe { }` wrap) do not fold and keep their block
            // body so the emitted G# stays correct.
            private func TryFoldArrowBody(block BlockStatement?, allowRefReturn bool = false) GStatement? {
                if block == nil || block.IsUnsafe || block.Statements.Count != 1 {
                    return nil
                }
                let only = block.Statements[0]
                return switch only {
                    case refReturn is ReturnStatement when refReturn.IsRef && !allowRefReturn: default(GStatement?)
                    case r is ReturnStatement when r.Expression != nil: cast[GStatement](r)
                    case _ is ExpressionStatement: only
                    case _ is AssignmentStatement: only
                    default: default(GStatement?)
                }
            }

            // `SyntaxList<T>`/`List<T>` both expose `IndexOf`, but the generalized
            // `IReadOnlyList<StatementSyntax>` overload above does not — this finds
            // the same (reference-identity) index for either concrete backing store.
            private func IndexOfReference(
                statements IReadOnlyList[Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax],
                target Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
            ) int32 {
                for var i = 0; i < statements.Count; i++ {
                    if object.ReferenceEquals(statements[i], target) {
                        return i
                    }
                }
                return -1
            }

            // Establishes a fresh statement seam (issue #1731) around each statement's
            // translation: any spill hoisted while translating `statement` (see
            // <see cref="SpillOperand"/>) is collected into its own prologue and
            // emitted immediately ahead of `statement`'s own output, then the ambient
            // seam is restored — so a nested statement (e.g. a block's own children)
            // always gets its own independent seam rather than sharing this one.
            // Issue #3501 B3: a comment on the SAME line after the statement
            // rides as the emitted statement's trailing comment.
            private func AttachTrailingComment(node GNode?, source Microsoft.CodeAnalysis.SyntaxNode?) {
                if node == nil || source == nil || node.TrailingComment != nil {
                    return
                }
                for trivia in source.GetTrailingTrivia() {
                    if trivia.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.EndOfLineTrivia) {
                        break
                    }
                    if trivia.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.SingleLineCommentTrivia) {
                        node.TrailingComment = trivia.ToString().TrimEnd()
                        break
                    }
                }
            }

            /// Issue #4422: gives one translated C# statement the ADR-0175
            /// suppressions its by-reference arguments need, with a scope no wider
            /// than that statement. A local declaration carries the annotation
            /// itself (wrapping it in a block would hide the local from the
            /// statements after it); every other run of statements is wrapped in
            /// the `@SuppressDiagnostic("ID") { … }` block form. A statement
            /// that declares something else visible to later statements (a label,
            /// a local function, a deconstructing declaration), or a `defer`
            /// whose timing a block would change, is left unsuppressed rather than
            /// widened: the result is a visible warning, never a hidden one.
            /// @param statements The statement's translated output.
            /// @param suppressions The identifiers to suppress.
            /// @returns The output with the suppressions applied.
            private func ApplyStatementSuppressions(statements List[GStatement], suppressions HashSet[string]?) List[
                GStatement
            ] {
                if suppressions == nil || suppressions.Count == 0 || statements.Count == 0 {
                    return statements
                }
                let ids = suppressions.OrderBy((id string) -> id, StringComparer.Ordinal).ToList()
                let result = List[GStatement](statements.Count)
                let run = List[GStatement]()
                for statement in statements {
                    switch statement {
                        case local is LocalDeclarationStatement {
                            FlushSuppressedRun(run, result, ids)
                            // gsc accepts no annotation on a `using` declaration,
                            // and a block would dispose the resource early.
                            if !local.IsUsing {
                                local.SuppressedDiagnostics = ids
                            }
                            result.Add(local)
                        }
                        case _ is LabeledStatement or
                            _ is LocalFunctionStatement or
                            _ is TupleDeconstructionStatement or
                            _ is MultiAssignmentStatement or
                            _ is DeferStatement {
                            FlushSuppressedRun(run, result, ids)
                            result.Add(statement)
                        }
                        default {
                            run.Add(statement)
                        }
                    }
                }
                FlushSuppressedRun(run, result, ids)
                return result
            }

            /// Issue #4422: whether a C# statement other than a local declaration
            /// introduces a variable that stays in scope after it — an
            /// `out var`, a pattern variable, or any other declaration
            /// expression outside a nested statement or lambda. C# lets such a
            /// variable leak into the enclosing block (`if (!TryGet(out var v))
            /// return; use(v);`), so the statement cannot be wrapped in a
            /// suppression block without hiding it. It is left unsuppressed.
            /// @param statement The C# statement.
            /// @returns `true` when a block would hide a variable.
            private func DeclaresVariableVisibleAfter(
                statement Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax
            ) bool {
                if statement is LocalDeclarationStatementSyntax {
                    // Annotated in place, never wrapped.
                    return false
                }
                return statement.DescendantNodes(
                    (node Microsoft.CodeAnalysis.SyntaxNode) -> node == statement ||
                        (
                        !(node is Microsoft.CodeAnalysis.CSharp.Syntax.StatementSyntax) &&
                            !(node is AnonymousFunctionExpressionSyntax)
                    )
                )
                    .Any(
                    (node Microsoft.CodeAnalysis.SyntaxNode) -> node is SingleVariableDesignationSyntax ||
                        node is ParenthesizedVariableDesignationSyntax
                )
            }

            private func FlushSuppressedRun(run List[GStatement], result List[GStatement], ids List[string]) {
                if run.Count == 0 {
                    return
                }
                // A lone comment or other raw line needs no scope.
                if run.TrueForAll((statement GStatement) -> statement is RawStatement) {
                    result.AddRange(run)
                } else {
                    result.Add(BlockStatement(List[GStatement](run)){SuppressedDiagnostics = ids})
                }
                run.Clear()
            }
        }
    }

    shared {
        /// Identifies a non-fatal warning that an accessor-level attribute could
        /// not be represented in G# and was dropped.
        const AccessorAttributeDroppedDiagnosticId string = "CS2GS-ACCESSOR-ATTRIBUTE-DROPPED"
    }
}
