// <copyright file="CSharpToGSharpTranslator.Members.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Translator

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator.Loading
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
import System.Text.RegularExpressions

partial class CSharpToGSharpTranslator {
    private partial class DeclarationVisitor : CSharpSyntaxVisitor[GMember] {
        private func TranslateMember(
            member MemberDeclarationSyntax,
            ownerKind TypeDeclarationKind,
            lift ConstructorLift,
            propertyCtorInits IReadOnlyList[(Name string?, Value GExpression?)],
            primaryCtorParamNames IReadOnlyCollection[string]? = nil,
            callSiteLoweredStructConstructors IReadOnlyCollection[ConstructorDeclarationSyntax]? = nil,
            ownedExtensionTarget INamedTypeSymbol? = nil
        ) sequence[(Member GMember?, IsStatic bool)] {
            switch member {
                case field is FieldDeclarationSyntax {
                    for (m, s) in this.TranslateField(field, lift) {
                        yield(m, s)
                    }
                }
                case method is MethodDeclarationSyntax {
                    let preservedOwnedExtension = ownedExtensionTarget == nil && this.context.GetDeclaredSymbol(
                        method
                    ) is IMethodSymbol ownedMethod &&
                        this.IsPreservedOwnedExtension(ownedMethod)
                    // ADR-0169 M5 / issue #3686: private plumbing of a Roslyn
                    // analyzer test harness whose body is being replaced by a
                    // delegation to the G# verifier is dead code that would
                    // otherwise drag unmapped Roslyn types into the migrated
                    // project (MetadataReference, CSharpCompilationOptions).
                    if this.IsAnalyzerHarnessSupportMember(method) {
                        break
                    }
                    let (methodMember, methodIsStatic) = this.TranslateMethod(
                        method,
                        ownerKind,
                        ownedExtensionTarget: ownedExtensionTarget,
                        forceExtensionReceiver: preservedOwnedExtension
                    )
                    if methodMember != nil {
                        yield(methodMember, methodIsStatic)
                    }
                    if ownedExtensionTarget == nil && !preservedOwnedExtension && this.context.GetDeclaredSymbol(
                        method
                    ) is IMethodSymbol companionSymbol &&
                        this
                        .HasReceiverCompanion(companionSymbol) {
                        let (companion, companionIsStatic) = this.TranslateOwnerScopedCompanion(
                            method,
                            ownerKind,
                            companionSymbol
                        )
                        if companion != nil {
                            yield(companion, companionIsStatic)
                        }
                    }
                }
                case extensionBlock is ExtensionBlockDeclarationSyntax {
                    for (m, s) in this.TranslateExtensionBlock(extensionBlock, ownerKind) {
                        yield(m, s)
                    }
                }
                case op is OperatorDeclarationSyntax {
                    let (opMember, opIsStatic) = this.TranslateOperator(op)
                    if opMember != nil {
                        yield(opMember, opIsStatic)
                    }
                }
                case eventField is EventFieldDeclarationSyntax {
                    for (m, s) in this.TranslateEventField(eventField) {
                        yield(m, s)
                    }
                }
                case explicitEvent is EventDeclarationSyntax {
                    yield this.TranslateExplicitEvent(explicitEvent)
                }
                case nestedDelegate is DelegateDeclarationSyntax {
                    let translatedDelegate GMember? = this.TranslateDelegateDeclaration(nestedDelegate)
                    if translatedDelegate != nil {
                        yield(translatedDelegate, true)
                    }
                }
                case property is PropertyDeclarationSyntax {
                    let propertySymbol IPropertySymbol? = this.context.GetDeclaredSymbol(property) as IPropertySymbol
                    if !this.emitGeneratedImplementingParts &&
                        propertySymbol?.PartialDefinitionPart is IPropertySymbol regexPropertyDefinition &&
                        CSharpToGSharpTranslator.HasAttribute(
                        regexPropertyDefinition,
                        CSharpToGSharpTranslator.GeneratedRegexAttributeName
                    ) &&
                        regexPropertyDefinition
                        .DeclaringSyntaxReferences
                        .Any((reference SyntaxReference) -> this.IsTranslatedByThisRun(reference.SyntaxTree)) {
                        break
                    }
                    let propertyAttributes = this.MapPropertyAttributes(property)
                    if (ownerKind == TypeDeclarationKind.DataClass || ownerKind == TypeDeclarationKind.DataStruct) &&
                        IsExplicitPositionalAutoProperty(property, propertySymbol) &&
                        propertyAttributes.Count == 0 &&
                        propertySymbol != nil &&
                        propertySymbol.IsStatic == false &&
                        propertySymbol.IsVirtual == false &&
                        propertySymbol.IsOverride == false &&
                        propertySymbol.DeclaredAccessibility == Accessibility.Public &&
                        propertySymbol
                        .GetMethod
                        ?.DeclaredAccessibility == Accessibility.Public &&
                        propertySymbol.SetMethod is {IsInitOnly: true} &&
                        propertySymbol.SetMethod!!.DeclaredAccessibility == Accessibility.Public &&
                        property
                        .Initializer
                        ?.Value is {} primaryValue &&
                        this
                        .context
                        .GetSymbolInfo(primaryValue)
                        .Symbol is IParameterSymbol primaryParameter &&
                        primaryParameter.Name == propertySymbol.Name &&
                        SymbolEqualityComparer
                        .IncludeNullability
                        .Equals(primaryParameter.Type, propertySymbol.Type) && SymbolEqualityComparer.Default.Equals(
                        primaryParameter.ContainingSymbol.ContainingType,
                        propertySymbol.ContainingType
                    ) &&
                        property
                        .AccessorList
                        ?.Accessors
                        .All(
                        (accessor AccessorDeclarationSyntax) -> accessor.Body == nil &&
                            accessor.ExpressionBody == nil &&
                            accessor
                            .AttributeLists
                            .Count == 0
                    ) == true {
                        break
                    }
                    if propertySymbol != nil && lift.PropertiesAsPrimaryParameters.Contains(propertySymbol) {
                        break
                    }
                    // Issue #2281: a non-constant-initializer auto-property lifted
                    // to a body field (see PropertiesAsBodyFields) emits as a plain
                    // `let Name Type = initializer` field rather than a primary-
                    // constructor parameter or a G# `prop`.
                    if propertySymbol != nil && lift.PropertiesAsBodyFields.Contains(propertySymbol) {
                        let bodyFieldInit = lift.BodyFieldInitializers[propertySymbol]
                        let bodyFieldType GTypeReference? = this.typeMapper.Map(
                            propertySymbol.Type,
                            this.context,
                            property.Identifier.GetLocation()
                        )
                        yield(
                            FieldDeclaration(
                                BindingKind.Let,
                                this.EmittedName(propertySymbol, property.Identifier.ValueText),
                                bodyFieldType,
                                bodyFieldInit,
                                Visibility.Public
                            ),
                            false
                        )
                        break
                    }
                    // ADR-0143 §D rule 3 (defensive): C# 13 partial properties
                    // have no G# surface, exactly like partial methods. Skip a
                    // partial-property DEFINITION node: an implemented property's
                    // defining part is dropped in favor of its implementation
                    // part (which translates normally), and an unimplemented
                    // partial-property definition is elided outright.
                    if propertySymbol != nil && propertySymbol.IsPartialDefinition == true {
                        // Issue #4370: unless the implementation is generated
                        // code this run does not translate — then the property
                        // would vanish, so say so.
                        this.ReportGeneratedPartialImplementation(
                            property,
                            propertySymbol,
                            propertySymbol.PartialImplementationPart
                        )
                        break
                    }
                    if this.TryTranslateStaticInitializedAutoProperty(
                        property,
                        propertyAttributes,
                        out var staticBackingField,
                        out var staticProperty
                    ) {
                        yield(staticBackingField!!, true)
                        yield(staticProperty!!, true)
                        break
                    }
                    let (propMember, propIsStatic, fieldKeywordBackingField) = this.TranslateProperty(
                        property,
                        propertyAttributes,
                        primaryCtorParamNames
                    )
                    if fieldKeywordBackingField != nil {
                        // Issue #1907: the synthesized backing field for a `field`-
                        // keyword property is emitted alongside (before) the
                        // property itself, mirroring a hand-written computed
                        // property with an explicit backing field (ADR-0051 §2).
                        // Static/instance-ness must match the property's own.
                        yield(fieldKeywordBackingField, propIsStatic)
                    }
                    yield(propMember!!, propIsStatic)
                }
                case indexer is IndexerDeclarationSyntax {
                    yield this.TranslateIndexer(indexer)
                }
                case ctor is ConstructorDeclarationSyntax {
                    if callSiteLoweredStructConstructors?.Contains(ctor) == true {
                        break
                    }
                    // T2: a fully-lifted constructor is dropped entirely; its field
                    // initialization moved to field initializers / primary-ctor
                    // parameters (ADR-0115 §B.3). Assignments whose RHS reads an
                    // instance member cannot become field initializers, so they are
                    // re-emitted here as a synthesized parameterless `init() { ... }`.
                    if lift.DropConstructor && lift.Constructor == ctor {
                        if lift.ResidualInitStatements.Count > 0 {
                            yield(
                                ConstructorDeclaration(
                                    List[Parameter](),
                                    BlockStatement(List[GStatement](lift.ResidualInitStatements))
                                ),
                                false
                            )
                        }
                        break
                    }
                    let built GMember? = this.TranslateConstructor(ctor, propertyCtorInits)
                    if built != nil {
                        yield(built, ctor.Modifiers.Any(SyntaxKind.StaticKeyword))
                    }
                }
                case destructor is DestructorDeclarationSyntax {
                    // A C# finalizer `~T()` maps to the G# `deinit { ... }` block
                    // (ADR-0068, reference types only).
                    yield(
                        DestructorDeclaration(
                            this.TranslateBody(destructor, "finalizer on '${destructor.Identifier.Text}'"),
                            this.MapAttributes(destructor.AttributeLists)
                        ),
                        false
                    )
                }
                case nestedType is BaseTypeDeclarationSyntax {
                    let nested GMember? = this.Visit(nestedType)
                    if nested != nil {
                        yield(nested, true)
                    }
                }
                case conversion is ConversionOperatorDeclarationSyntax {
                    // gsc issue #1017: a C# user-defined conversion operator
                    // (`public static implicit/explicit operator T(U x)`) maps to
                    // the canonical G# `func operator implicit/explicit (x U) T`
                    // in-body member. `implicit`/`explicit` are contextual keywords
                    // right after `operator`; the single C# parameter is the
                    // conversion source and the C# target type becomes the return
                    // type (ADR-0115 §B).
                    yield this.TranslateConversionOperator(conversion)
                }
                default {
                    this.context.ReportUnsupported(
                        member,
                        "member '${member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.11)."
                    )
                }
            }
        }

        private func CanLowerOwnedExtension(method MethodDeclarationSyntax) bool {
            if !this.ownedExtensions.Contains(method) {
                return false
            }
            using let modelScope = this.context.UseSemanticModelFor(method.SyntaxTree)
            if this.context.GetDeclaredSymbol(method) is not IMethodSymbol symbol ||
                !symbol.IsExtensionMethod ||
                symbol.DeclaredAccessibility == Accessibility.Private ||
                symbol.IsExtern ||
                symbol
                .Parameters
                .Length == 0 {
                return false
            }
            if !this.CanPreserveSuspendingExtensionSignature(symbol, method) {
                return false
            }
            let receiver = symbol.Parameters[0]
            return receiver.RefKind == RefKind.None &&
                receiver.Type is INamedTypeSymbol receiverType &&
                (receiverType.TypeKind == TypeKind.Class || receiverType.TypeKind == TypeKind.Struct) &&
                !CSharpToGSharpTranslator.IsGenericReceiver(receiverType) && !this.ShouldPromoteToNullableReference(
                receiver
            )
        }

        // RequiresExplicitExtensionReceiver (issue #3357) retired by
        // ADR-0182: every receiver clause prints identically now, whether
        // the receiver is an enum, an owned type, or an ordinary
        // cross-package/CLR type, so there is no longer a translation-time
        // decision to make here.
        /// Issue #1879: translates a C# 14 `extension(T x) { ... }` /
        /// `extension(T) { ... }` block, mapping its members onto the same
        /// canonical target as a classic `this T x` extension method
        /// (ADR-0115 §B.19). The block itself carries no G# declaration of its
        /// own — it is a pure grouping construct — so every yielded member is one
        /// of its declared instance/static methods or properties:
        /// - a <b>static</b> member (method or property) has no receiver and becomes a plain `shared` member of
        /// the enclosing (necessarily `static`) class; its call sites — always qualified through the *extended
        /// type's name* (`string.Repeat(...)`), never the declaring class — are rewritten in
        /// (cref:TranslateMemberAccess);
        /// - an <b>instance</b> method becomes a receiver-clause `func` exactly like a classic extension
        /// method, reusing (cref:TranslateMethod) with the block's own parameter supplied as the forced
        /// receiver;
        /// - an <b>instance</b> property has no receiver-clause form in the G# grammar (`prop` carries no
        /// receiver clause) and is instead lowered to a receiver-clause `func` named after the property; a
        /// property with a setter has no call-site lowering (an assignment target), so it is reported as an
        /// explicit, loud gap rather than silently mistranslated.
        private func TranslateExtensionBlock(
            node ExtensionBlockDeclarationSyntax,
            ownerKind TypeDeclarationKind
        ) sequence[(Member GMember?, IsStatic bool)] {
            // Issue #1879: a generic extension block (`extension<T>(IEnumerable<T> src)
            // where T : notnull { ... }`) is a real C# 14 form, but G#'s
            // receiver-clause `func`/`prop` grammar carries no block-level type
            // parameter or constraint clause. Silently dropping `T` would emit a
            // dangling, wrong-generic G# member with no gap raised — a silent
            // miscompile. Full generic-extension lowering (synthesizing a generic
            // owner, threading `T` through every member and call site) is a larger
            // follow-up; gap loudly instead (ADR-0115 §B.19).
            if node.TypeParameterList != nil || node.ConstraintClauses.Count > 0 {
                this.context.ReportUnsupported(
                    node,
                    "a generic extension block (`extension<T>(...)`) has no canonical G# mapping yet; G#'s receiver-clause `func`/`prop` grammar carries no block-level type parameter or constraint clause (ADR-0115 §B.19)."
                )
                yield break
            }
            let receiverParameter ParameterSyntax? = if node.ParameterList!!.Parameters.Count > 0 {
                node.ParameterList!!.Parameters[0]
            } else {
                default(ParameterSyntax?)
            }
            // Issue #2009: the C# 14 receiver parameter may carry `ref`/`in`/
            // `scoped`/`ref readonly` modifiers (`extension(ref T x)`,
            // `extension(in T x)`, `extension(scoped T x)`). G#'s own receiver
            // CLAUSE (`func (x T) M()`, ADR-0019) reuses the general `Parameter`
            // grammar, which syntactically accepts the same modifier tokens —
            // but gsc's declaration binder (`DeclarationBinder.BindFunctionDeclaration`)
            // never reads `syntax.Receiver`'s ref-kind/scoped modifier tokens when
            // constructing the receiver's bound `ParameterSymbol`: it always binds
            // a plain by-value receiver. Printing the modifier would therefore
            // parse silently while gsc silently discards its by-ref/scoped
            // semantics — a genuine silent miscompile (a `ref` receiver mutating
            // the caller's struct in C# would instead operate on a throwaway
            // copy in G#, with no diagnostic). No canonical G# mapping exists
            // yet, so gap loudly instead of emitting a modifier gsc will ignore.
            if receiverParameter?.Modifiers.Count > 0 {
                let modifierText = string.Join(" ", receiverParameter!!.Modifiers.Select((m SyntaxToken) -> m.Text))
                this.context.ReportUnsupported(
                    node,
                    "an extension block receiver parameter modifier ('$modifierText') has no canonical G# mapping yet; G#'s receiver-clause grammar accepts the same modifier tokens syntactically, but gsc's binder does not honor by-ref/scoped semantics on a receiver-clause parameter, so mapping the modifier through would silently change behavior rather than gap (ADR-0115 §B.19, ADR-0019)."
                )
                yield break
            }
            // A receiverless block (`extension(string) { ... }`) names only the
            // extended type, with no identifier to bind — it may declare static
            // members only. A named block (`extension(string s) { ... }`) binds
            // `s` as the receiver for its instance members (and may still declare
            // static members that simply ignore it).
            let hasNamedReceiver = receiverParameter != nil &&
                !receiverParameter
                .Identifier
                .IsMissing &&
                receiverParameter
                .Identifier
                .ValueText
                .Length > 0
            var receiver Receiver? = nil
            if hasNamedReceiver {
                let receiverSymbol IParameterSymbol? = this.context.GetDeclaredSymbol(
                    receiverParameter
                ) as IParameterSymbol
                let receiverType GTypeReference? = if receiverSymbol != nil {
                    this.typeMapper.Map(receiverSymbol.Type, this.context, receiverParameter!!.GetLocation())
                } else {
                    this.MapTypeSyntax(receiverParameter!!.Type)
                }
                let receiverAttributes List[AttributeUse]? = if receiverSymbol != nil {
                    this.MapParameterAttributes(receiverSymbol)
                } else {
                    this.MapAttributes(receiverParameter!!.AttributeLists)
                }
                receiver = Receiver(
                    this.EmittedName(receiverSymbol, receiverParameter!!.Identifier.ValueText),
                    receiverType,
                    receiverAttributes
                )
            }
            for member in node.Members {
                switch member {
                    case method is MethodDeclarationSyntax {
                        {
                            let methodSymbol IMethodSymbol? = this.context.GetDeclaredSymbol(method) as IMethodSymbol
                            let isStatic = methodSymbol != nil && methodSymbol.IsStatic
                            if !isStatic && receiver == nil {
                                this.context.ReportUnsupported(
                                    method,
                                    "instance extension member '${method.Identifier.Text}' has no receiver to bind (its enclosing extension block names no receiver); no canonical G# mapping (ADR-0115 §B.19)."
                                )
                                break
                            }
                            yield this.TranslateMethod(
                                method,
                                ownerKind,
                                if isStatic {
                                    default(Receiver?)
                                } else {
                                    receiver
                                }
                            )
                        }
                    }
                    case property is PropertyDeclarationSyntax {
                        {
                            let propertySymbol IPropertySymbol? = this.context.GetDeclaredSymbol(
                                property
                            ) as IPropertySymbol
                            let propertyAttributes = this.MapPropertyAttributes(property)
                            let isStatic = propertySymbol != nil && propertySymbol.IsStatic
                            if isStatic {
                                let (
                                    staticPropMember,
                                    staticPropIsStatic,
                                    staticFieldKeywordBacking
                                ) = this.TranslateProperty(property, propertyAttributes)
                                if staticFieldKeywordBacking != nil {
                                    yield(staticFieldKeywordBacking, staticPropIsStatic)
                                }
                                yield(staticPropMember!!, staticPropIsStatic)
                                break
                            }
                            if receiver == nil {
                                this.context.ReportUnsupported(
                                    property,
                                    "instance extension property '${property.Identifier.Text}' has no receiver to bind (its enclosing extension block names no receiver); no canonical G# mapping (ADR-0115 §B.19)."
                                )
                                break
                            }
                            if propertySymbol?.SetMethod != nil {
                                this.context.ReportUnsupported(
                                    property,
                                    "instance extension property '${property.Identifier.Text}' has a setter; G#'s `prop` grammar has no receiver clause (only `func` does, ADR-0115 §B.19), so it is lowered to a get-only receiver-clause func — a setter has no call-site lowering (it is an assignment target, not a call) and is reported rather than silently dropped."
                                )
                                break
                            }
                            yield this.TranslateExtensionProperty(property, receiver, propertyAttributes)
                        }
                    }
                    default {
                        this.context.ReportUnsupported(
                            member,
                            "extension-block member '${member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.19)."
                        )
                    }
                }
            }
        }

        /// Issue #1879: lowers a C# 14 instance extension property (declared
        /// inside an `extension(T x) { ... }` block) to a receiver-clause
        /// `func` named after the property — G#'s `prop` grammar has no
        /// receiver clause, so this is the only canonical target (ADR-0115
        /// §B.19). Every read call site (`word.DoubledLength`) is rewritten
        /// to a zero-argument call (`word.DoubledLength()`) in
        /// (cref:TranslateMemberAccess). Callers only reach this method for
        /// a get-only property (a setter is reported as an explicit gap first).
        private func TranslateExtensionProperty(
            node PropertyDeclarationSyntax,
            receiver Receiver,
            attributes List[AttributeUse]
        )(Member GMember, IsStatic bool) {
            let symbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            // Issue #3879: an EXTENSION property lowers to a receiver-clause
            // `func`, not to a `prop`, so the #3879 `prop … ref T` spelling does
            // not reach it — and this path never carried `isRefReturn` onto the
            // MethodDeclaration it builds. Gap rather than silently emit a
            // copy-returning function (the #3839 hazard).
            if symbol != nil && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly) {
                let refExtensionPropertyMessage = "ref-returning extension property '${node.Identifier.Text}' has no G# form: an extension property " +
                    "lowers to a receiver-clause `func` (ADR-0115 §B.19), and the by-ref return is not carried across " +
                    "that lowering. Emitting it would silently return a copy (issues #3839 / #3879)."
                this.context.ReportUnsupported(node, refExtensionPropertyMessage)
            }
            let returnType GTypeReference? = if symbol != nil {
                this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            let accessors = this.MapAccessors(node)
            let arrowBody GStatement? = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors)
            let body BlockStatement? = if arrowBody == nil {
                accessors.FirstOrDefault((a PropertyAccessor) -> a.Kind == Cs2Gs.CodeModel.Ast.AccessorKind.Get)?.Body
            } else {
                default(BlockStatement?)
            }
            let method = MethodDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                List[Parameter](),
                returnType,
                body,
                receiver: receiver,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody
            )
            return (method, false)
        }

        private func TranslateEventField(node EventFieldDeclarationSyntax) sequence[(Member GMember, IsStatic bool)] {
            // `public event EventHandler<T>? X;` → G# `public event X EventHandler[T]`
            // (name-then-type; the nullable annotation is dropped because a
            // field-like event is nil-initialized; ADR-0115 §B).
            for declarator in node.Declaration.Variables {
                let symbol IEventSymbol? = this.context.GetDeclaredSymbol(declarator) as IEventSymbol
                let type GTypeReference? = if symbol != nil {
                    this.typeMapper.MapEventType(
                        symbol.Type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated),
                        this.context,
                        declarator.GetLocation()
                    )
                } else {
                    this.MapTypeSyntax(node.Declaration.Type)
                }
                let declaration = EventDeclaration(
                    this.EmittedName(symbol, declarator.Identifier.ValueText),
                    type,
                    MapVisibility(symbol, this.context, node),
                    this.MapAttributes(node.AttributeLists),
                    isOpen: this.IsMemberEmittedOpen(symbol, symbol?.IsOverride == true),
                    isOverride: symbol?.IsOverride == true
                )
                yield(declaration, symbol != nil && symbol.IsStatic)
            }
        }

        private func TranslateExplicitEvent(node EventDeclarationSyntax)(Member GMember?, IsStatic bool) {
            // `public event Handler X { add { ... } remove { ... } }` — the explicit
            // accessor form of ADR-0052 §2. No backing field is synthesized; the
            // `add`/`remove` bodies translate like any other accessor body, with
            // `value` bound as the implicit handler parameter (already an ordinary
            // identifier in the C# source, so it round-trips unchanged).
            let symbol IEventSymbol? = this.context.GetDeclaredSymbol(node) as IEventSymbol
            // ADR-0149 (issue #2362 follow-up): generalizes the method/property/
            // indexer explicit-interface qualifier clause to events for the first
            // time — a C# explicit event implementation
            // (`event Handler IFoo.Changed { add; remove; }`) maps to
            // `event (IFoo) Changed T`, using the same clause + CLR MethodImpl
            // bridge as every other member kind. Source and imported CLR
            // interfaces both resolve through the clause. Only the
            // custom add/remove accessor form (this method) can carry an explicit
            // interface specifier in C# — a field-like event never can — so
            // TranslateEventField needs no matching change.
            let isExplicitInterfaceEventImpl = symbol != nil && symbol.ExplicitInterfaceImplementations.Length > 0
            let usesExplicitInterfaceEventClause = isExplicitInterfaceEventImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length == 1
            if isExplicitInterfaceEventImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length > 1 &&
                symbol!!
                .ExplicitInterfaceImplementations
                .All((e IEventSymbol) -> e.ContainingType.Locations.Any((l Location) -> l.IsInSource)) {
                let names = string.Join(
                    ", ",
                    symbol!!.ExplicitInterfaceImplementations.Select((e IEventSymbol) -> e.ContainingType.Name)
                )
                let multiEntryMessage = "explicit interface event implementation '${FormatExplicitInterfaceEventName(symbol)}' satisfies " +
                    "more than one G# user interface member in one C# declaration ($names), likely via interface " +
                    "inheritance (a base interface re-declaring the same event). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per event, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the event keeps its plain name " +
                    "and every interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: " +
                    "the event becomes publicly subscribable by name, unlike real C# explicit-impl semantics)."
                this.context.Report(
                    TranslationDiagnostic(
                        "EventDeclaration",
                        multiEntryMessage,
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            if isExplicitInterfaceEventImpl && !usesExplicitInterfaceEventClause {
                let eventSurvivor IEventSymbol? = FindPriorCollidingSiblingEvent(symbol, node)
                if eventSurvivor != nil {
                    let message = "explicit interface event implementation '${symbol!!.ContainingType.Name}.${FormatExplicitInterfaceEventName(symbol)}' " +
                        "shares its name with '${symbol!!.ContainingType.Name}.${FormatSiblingEventName(eventSurvivor)}'; " +
                        "one C# declaration targets multiple interface slots, while ADR-0149 carries one qualifier, so the " +
                        "two events cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "subscription through the interface-typed reference that previously reached this event now " +
                        "silently observes the surviving event instead (semantic loss, known gap, issue #1911 " +
                        "analogue). Separate explicit declarations with distinct qualifiers are fully supported (issue " +
                        "#2362 follow-up, ADR-0149 explicit-interface clause)."
                    this.context.Report(
                        TranslationDiagnostic(
                            "EventDeclaration",
                            message,
                            node.GetLocation(),
                            TranslationSeverity.Unsupported
                        )
                    )
                    return (nil, false)
                }
            }
            // ADR-0149: the resolved explicit-interface qualifier clause type for
            // a single-slot explicit event implementation, or null otherwise.
            let explicitInterfaceEventType GTypeReference? = if usesExplicitInterfaceEventClause {
                this.typeMapper.Map(
                    symbol!!.ExplicitInterfaceImplementations[0].ContainingType,
                    this.context,
                    node.GetLocation()
                )
            } else {
                default(GTypeReference?)
            }
            let type GTypeReference? = if symbol != nil {
                this.typeMapper.MapEventType(
                    symbol.Type.WithNullableAnnotation(Microsoft.CodeAnalysis.NullableAnnotation.NotAnnotated),
                    this.context,
                    node.GetLocation()
                )
            } else {
                this.MapTypeSyntax(node.Type)
            }
            let addAccessor AccessorDeclarationSyntax? = node
                .AccessorList
                ?.Accessors
                .FirstOrDefault((a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.AddAccessorDeclaration))
            let removeAccessor AccessorDeclarationSyntax? = node
                .AccessorList
                ?.Accessors
                .FirstOrDefault((a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.RemoveAccessorDeclaration))
            let addBody = if addAccessor != nil {
                this.TranslateBody(addAccessor, "'add' accessor of event '${node.Identifier.Text}'")
            } else {
                BlockStatement(List[GStatement]())
            }
            let removeBody = if removeAccessor != nil {
                this.TranslateBody(removeAccessor, "'remove' accessor of event '${node.Identifier.Text}'")
            } else {
                BlockStatement(List[GStatement]())
            }
            // ADR-0149: see the matching visibility comment in
            // TranslatePropertyDeclaration for the full rationale — a G#
            // explicit event implementation (explicit-interface clause + CLR
            // MethodImpl) keeps C#'s own `private`-equivalent visibility.
            let eventVisibility = if isExplicitInterfaceEventImpl && !usesExplicitInterfaceEventClause {
                Visibility.Default
            } else {
                MapVisibility(symbol, this.context, node)
            }
            let declaration = EventDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                type,
                eventVisibility,
                this.MapAttributes(node.AttributeLists),
                addBody,
                removeBody,
                explicitInterfaceType: explicitInterfaceEventType,
                isOpen: this.IsMemberEmittedOpen(symbol, symbol?.IsOverride == true),
                isOverride: symbol?.IsOverride == true
            )
            return (declaration, symbol != nil && symbol.IsStatic)
        }

        private func TranslateDelegateDeclaration(node DelegateDeclarationSyntax) GMember {
            // `public delegate R Name(params);` → G# named delegate type alias
            // `delegate Name(params) R` (ADR-0059). Generic delegates;
            // (issue #1960) carry their type parameters into the bracket section,
            // `delegate Name[T](params) R` — gsc's binder/emitter;
            // support this (ADR-0059 "Follow-up work", issue #1503; GS0234 retired).
            let symbol INamedTypeSymbol? = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol
            let invoke IMethodSymbol? = symbol?.DelegateInvokeMethod
            let parameters = this.MapParameterList(node.ParameterList)
            let returnType GTypeReference? = if invoke != nil {
                this.MapDelegateLikeReturnType(invoke, isAsync: false, node.ReturnType.GetLocation())
            } else {
                this.MapTypeSyntax(node.ReturnType)
            }
            let typeParameters = this.MapTypeParameters(symbol)
            let isNested = CSharpTypeMapper.IsLiftedNestedDelegate(symbol)
            let name string? = if isNested {
                this.typeMapper.LiftedNestedDelegateName(symbol, this.context)
            } else {
                this.EmittedName(symbol, node.Identifier.ValueText)
            }
            var visibility = MapVisibility(symbol, this.context, node)
            if isNested {
                // Issue #4676: a nested delegate's reach is bounded by every type that
                // encloses it. A `public` delegate inside an `internal` class
                // (GSharp.Core's `OverloadResolver.TryBindClrConstructorCallDelegate`)
                // was lifted to a top-level `public` delegate, publishing a type the
                // C# assembly never exported.
                //
                // Only a delegate that is public (the default) AND has exclusively public
                // containers stays public. Anything else becomes `internal`: a lifted
                // delegate has no container left to be `protected` or `private` in, and a
                // top-level `protected` declaration is GS0380.
                if !((visibility == Visibility.Default || visibility == Visibility.Public)) ||
                    !CSharpToGSharpTranslator.IsEffectivelyPublic(symbol) {
                    visibility = Visibility.Internal
                }
                this.context.Report(
                    TranslationDiagnostic(
                        "DelegateDeclaration",
                        "nested delegate '${symbol!!.ToDisplayString()}' lifted to top-level '$name' because G# named delegate declarations are top-level-only; non-public visibility is emitted as internal (ADR-0059/ADR-0110).",
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            return NamedDelegateDeclaration(
                name,
                parameters,
                returnType,
                visibility,
                this.MapAttributes(node.AttributeLists),
                typeParameters
            )
        }

        /// Wraps a translated constant expression in an explicit G# cast when the
        /// C# semantic model implicitly converts a signed-integer constant to an
        /// unsigned-integer target (`uint x = 0`, `const byte b = 31`).
        /// G# requires the conversion to be explicit (OD-T2, otherwise GS0156
        /// "Cannot convert int32 to uintN").
        private func CoerceConstantToUnsigned(expression ExpressionSyntax, translated GExpression?) GExpression? {
            let info = this.context.GetTypeInfo(expression)
            let source ITypeSymbol? = info.Type
            let target ITypeSymbol? = info.ConvertedType
            if source != nil && target != nil && !SymbolEqualityComparer.Default.Equals(source, target) &&
                IsSignedIntegerSpecialType(source.SpecialType) &&
                IsUnsignedIntegerSpecialType(target.SpecialType) {
                let targetRef GTypeReference? = this.typeMapper.Map(target, this.context, expression.GetLocation())
                return ConversionExpression(targetRef, translated)
            }
            return translated
        }

        private func TranslateField(field FieldDeclarationSyntax, lift ConstructorLift) sequence[
            (Member GMember, IsStatic bool)
        ] {
            for declarator in field.Declaration.Variables {
                let symbol IFieldSymbol? = this.context.GetDeclaredSymbol(declarator) as IFieldSymbol
                // T2: a field that became a primary-constructor parameter is no
                // longer a standalone member (the parameter declares the field).
                if lift.FieldsAsPrimaryParameters.Contains(declarator.Identifier.ValueText) {
                    continue
                }
                // Issue #4371: a C# fixed-size buffer field
                // (`public fixed sbyte Name[32];`) maps to G#'s own
                // fixed-size buffer field form (ADR-0122 §10):
                // `fixed Name [32]int8`. Roslyn exposes such a field's
                // `Type` as a POINTER to the element type (`sbyte*`), with
                // `IsFixedSizeBuffer`/`FixedSize` separately carrying the
                // true element type and element count; translating it
                // through the ordinary `symbol.Type` path below emits a bare
                // `var Name *int8` raw-pointer field instead — one gsc's
                // `fixed` statement then rejects with GS0401 when the
                // (already-mistranslated) field is pinned.
                if symbol != nil &&
                    symbol.IsFixedSizeBuffer == true &&
                    symbol.Type is IPointerTypeSymbol fixedBufferPointerType {
                    let fixedBufferElementType GTypeReference? = this.typeMapper.Map(
                        fixedBufferPointerType.PointedAtType,
                        this.context,
                        declarator.GetLocation()
                    )
                    yield(
                        FieldDeclaration(
                            BindingKind.FixedBuffer,
                            this.EmittedName(symbol, declarator.Identifier.ValueText),
                            fixedBufferElementType,
                            visibility: MapVisibility(symbol, this.context, field),
                            attributes: this.MapAttributes(field.AttributeLists),
                            fixedBufferLength: symbol.FixedSize
                        ),
                        false
                    )
                    continue
                }
                let binding = switch symbol {
                    case {IsConst: true}: BindingKind.Const
                    case {IsReadOnly: true}: BindingKind.Let
                    default: BindingKind.Var
                }
                var type GTypeReference? = if symbol != nil {
                    this.typeMapper.Map(symbol.Type, this.context, declarator.GetLocation())
                } else {
                    cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
                }
                // Generator-produced fields declared under nullable-oblivious
                // context (Avalonia x:Name fields are the common case) retain
                // C#'s ability to hold/test null when translated as a standalone
                // generated partial part.
                if this.widenObliviousReferenceFields &&
                    symbol
                    ?.Type
                    ?.IsReferenceType == true &&
                    symbol!!
                    .Type
                    .NullableAnnotation == Microsoft
                    .CodeAnalysis
                    .NullableAnnotation
                    .None {
                    type = MakeNullable(type)
                }
                // Issue #1072: a non-nullable reference/array field that is
                // null-checked or null-assigned anywhere in the declaring type is
                // really nullable; render it `T?` so the `== nil` guard type-checks.
                if symbol != nil {
                    type = this.PromoteIfUsedAsNullable(type, symbol)
                    type = this.PromoteIfGeneratedPropertyTargetNullable(type, symbol)
                    // Issue #3848 (family B): a generated `T[]` field written a
                    // maybe-null ELEMENT renders `[]T?`.
                    type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol)
                }
                // T2: a field initializer (ADR-0115 §B.3) comes either from a
                // constructor assignment independent of the constructor parameters
                // (lifted out of the dropped `init`) or from a C# field initializer.
                var initializer GExpression? = nil
                if lift.FieldInitializers.TryGetValue(declarator.Identifier.ValueText, out var lifted) {
                    initializer = lifted
                } else if symbol != nil &&
                    this
                    .state
                    .StaticFieldInitializers
                    .TryGetValue(symbol, out var staticLifted) {
                    // Issue #1729 (mode 1): a folded `static` constructor
                    // (`static T() { Field = value; }`) runs *after* the field's own
                    // inline initializer in C#, so its assigned value — not the
                    // inline initializer — is the field's true final value. Prefer
                    // it over `declarator.Initializer` even when both are present.
                    //
                    // Issue #1729 (N1): dropping `declarator.Initializer` this way is
                    // only safe when its RHS is side-effect-free (a constant/literal/
                    // `new T()` shape). If it can run observable side effects (e.g.
                    // `static int X = Log(1);`), C# still runs them before the cctor
                    // overwrites the field, and silently folding to just the cctor
                    // value would drop that side effect. Report instead of folding.
                    if declarator.Initializer != nil && this.ContainsPotentialSideEffect(
                        declarator.Initializer!!.Value
                    ) {
                        let message = "field '${declarator.Identifier.Text}' has a side-effecting inline " +
                            "initializer that a static constructor overwrites; folding would " +
                            "silently drop the initializer's side effect (ADR-0115 §B.11)."
                        this.context.ReportUnsupported(declarator, message)
                        continue
                    }
                    initializer = staticLifted
                } else if declarator.Initializer != nil {
                    initializer = this.CoerceConstantToUnsigned(
                        declarator.Initializer!!.Value,
                        this.TranslateNullSeamExpression(declarator.Initializer!!.Value)
                    )
                    initializer = this.ForgiveNullableReferenceValue(
                        declarator.Initializer!!.Value,
                        initializer,
                        symbol?.Type,
                        symbol
                    )
                    // Issue #1072: a non-nullable reference field whose initializer
                    // is nullable (e.g. `?.`-access) is rendered `T?`.
                    if symbol != nil {
                        type = this.PromoteIfInitializerNullable(type, symbol, declarator.Initializer!!.Value)
                    }
                }
                // Issue #4684: gsc gives a bare, non-nullable `[]T` instance field of a
                // class a synthesized zero value (ADR-0159): a fresh zero-length array
                // allocated in every constructor prologue, BEFORE the constructor body
                // assigns the real value. C# leaves such a field null, so the migrated
                // type allocated 24 extra bytes per instance (the redundant array made
                // `ManagedLocationKey` 64 bytes instead of 40, tripping the array-location
                // allocation bound under self-host stage 2). Cache the empty value
                // only when every constructor overwrites it
                // before observation; otherwise its fresh identity must be retained.
                if initializer == nil &&
                    binding != BindingKind.Const &&
                    symbol != nil &&
                    symbol.IsStatic == false &&
                    symbol
                    .ContainingType
                    ?.TypeKind == TypeKind.Class &&
                    type is ArrayTypeReference{Rank: 1, IsNullable: false} emptyArrayType &&
                    CanUseCachedEmptyArray(emptyArrayType.ElementType) &&
                    this.IsArrayFieldOverwrittenBeforeObservation(symbol) {
                    initializer = MakeArrayEmptyInvocation(emptyArrayType.ElementType)
                }
                let declaration = FieldDeclaration(
                    binding,
                    this.EmittedName(symbol, declarator.Identifier.ValueText),
                    type,
                    initializer: initializer,
                    visibility: MapVisibility(symbol, this.context, field),
                    attributes: this.MapAttributes(field.AttributeLists)
                )
                yield(declaration, symbol != nil && symbol.IsStatic)
            }
        }

        private func TranslateMethod(
            node MethodDeclarationSyntax,
            ownerKind TypeDeclarationKind,
            forcedReceiver Receiver? = nil,
            ownedExtensionTarget INamedTypeSymbol? = nil,
            forceExtensionReceiver bool = false,
            declaringPartSignature IMethodSymbol? = nil,
            isNativeImportDefinition bool = false,
            isGeneratedRegexDefinition bool = false
        )(Member GMember?, IsStatic bool) {
            let symbol IMethodSymbol? = declaringPartSignature ?? this.context.GetDeclaredSymbol(node) as IMethodSymbol
            var isStatic = symbol != nil && symbol.IsStatic
            let isOrdinaryMemberPosition = forcedReceiver == nil &&
                ownedExtensionTarget == nil &&
                !forceExtensionReceiver
            // ADR-0143's partial-method rule, as amended 2026-09-23 for
            // ADR-0192 (G# partial methods). A C# `partial` method translates
            // in one of three ways:
            //
            //   * Unimplemented partial method (`IsPartialDefinition` with a
            //     null `PartialImplementationPart`): the whole method is elided
            //     — no member here, and its call sites are dropped by the
            //     statement visitor (see IsElidedPartialMethodInvocation). G#
            //     rejects a lone declaring part (GS0609), so this stays.
            //   * Implemented pair that IsEmittablePartialMethodPair accepts
            //     (preserve-parts mode, both parts hand-authored source this
            //     run translates, a shape G# can spell): each C# part becomes
            //     its own G# `partial func` part, in the G# partial type part
            //     of its own C# file. Each part is SPELLED in its own file: the
            //     definition node is translated signature-only under the
            //     definition file's semantic model and at the definition's
            //     locations, but from the IMPLEMENTATION's symbol
            //     (`declaringPartSignature`), so the facts only the
            //     implementation knows — `async` (which C# lets only the
            //     implementation say), iterator and suspend unwrapping,
            //     nullability promotion keyed on its parameters — are the same
            //     on both parts. gsc compares the two signatures as text
            //     (GS0611), so the two files must also spell every type the same
            //     way, which only a post-pass over every translated file can
            //     check: the pair is TENTATIVE (both parts carry a
            //     PartialPairKey) and PartialMethodPairReconciler demotes it to
            //     the single-implementation shape when the printed signatures
            //     differ. This path is opt-in (`emitPartialMethodPairs`), for
            //     callers that run that post-pass. Parameter
            //     defaults (the definition's) and parameter attributes (the
            //     union of both parts, C#'s rule — same-file pairs only) are
            //     emitted identically on both parts; method-level attributes
            //     are unioned by gsc, so each part keeps its own.
            //   * Any other implemented pair (legacy merge mode — a
            //     non-partial G# type, where `partial func` is GS0608 —, a
            //     part in a generated/dropped document, an extension or
            //     explicit-interface method, differing parameter names, ...):
            //     only the implementation part translates, as an ordinary
            //     method. The defining node yields nothing here; the
            //     implementation node falls through and translates normally,
            //     so the member is emitted exactly once. This also covers the
            //     issue #1910 partial-TYPE merge, whose merged member list may
            //     contain both the defining and implementing method nodes.
            //   * ADR-0192 follow-on 2 (gsgen only,
            //     `emitGeneratedImplementingParts`): an implementation whose
            //     definition is in a tree this run does not emit — the stub
            //     rendered from the user's G# declaring part — is a G#
            //     implementing part, `partial func` with its body (see
            //     IsGeneratedImplementingPart). The definition is never
            //     translated there.
            //
            // Issue #4370: a `[LibraryImport]` definition is the exception —
            // its implementation is generator output cs2gs never translates,
            // and gsc spells the import natively as a body-less
            // `@LibraryImport` func (see CSharpToGSharpTranslator.LibraryImport.cs),
            // so the DEFINITION translates and the generated implementation
            // does not. Issue #4301: a `[GeneratedRegex]` definition likewise
            // translates, to a G# declaring part (`@GeneratedRegex(...)
            // partial func F() Regex;`) whose implementing part gsgen
            // generates at build (see CSharpToGSharpTranslator.GeneratedRegex.cs),
            // and its generated C# implementation does not. Any other
            // definition whose implementation is untranslated generated code
            // is reported, never silently dropped.
            if symbol != nil && symbol.IsPartialDefinition && !isNativeImportDefinition && !isGeneratedRegexDefinition {
                if isOrdinaryMemberPosition && CSharpToGSharpTranslator.IsLibraryImportDefinition(symbol) {
                    return this.TranslateLibraryImportDefinition(node, ownerKind, symbol)
                }
                if isOrdinaryMemberPosition && CSharpToGSharpTranslator.IsGeneratedRegexDefinition(symbol) {
                    return this.TranslateGeneratedRegexDefinition(node, ownerKind, symbol)
                }
                if isOrdinaryMemberPosition && this.IsEmittablePartialMethodPair(symbol, ownerKind, out _) {
                    return this.TranslateMethod(
                        node,
                        ownerKind,
                        declaringPartSignature: symbol.PartialImplementationPart
                    )
                }
                this.ReportGeneratedPartialImplementation(node, symbol, symbol.PartialImplementationPart)
                return (nil, false)
            }
            if symbol?.PartialDefinitionPart is IMethodSymbol importDefinition &&
                CSharpToGSharpTranslator.IsLibraryImportDefinition(importDefinition) {
                return (nil, false)
            }
            // Issue #4301: the implementation of a `[GeneratedRegex]`
            // definition this run translates (to a declaring part) is the
            // generator's output, which gsgen regenerates at build. It is
            // dropped even when it sits in a translated tree (a committed
            // generator output). gsgen itself translates it: there the
            // definition is only in the stub rendered from the user's G#.
            if symbol?.PartialDefinitionPart is IMethodSymbol regexDefinition &&
                CSharpToGSharpTranslator.IsGeneratedRegexDefinition(regexDefinition) &&
                regexDefinition
                .DeclaringSyntaxReferences
                .Any((reference SyntaxReference) -> this.IsTranslatedByThisRun(reference.SyntaxTree)) {
                if !GeneratedSourceDetection.IsGeneratedSource(node.SyntaxTree, this.projectDirectory) ||
                    !CSharpToGSharpTranslator
                    .IsRegexGeneratorDeclaration(symbol) {
                    let message = "[GeneratedRegex] method '${regexDefinition.ContainingType?.Name}.${regexDefinition.Name}' " +
                        "has a user-written partial implementation; cs2gs cannot replace that implementation " +
                        "with gsgen output without changing runtime behavior."
                    this.context.ReportUnsupported(node, message)
                }
                return (nil, false)
            }
            let isDeclaringPart = declaringPartSignature != nil
            // The node whose BODY carries implementation-only signature facts
            // (iterator `yield`, suspending calls): the implementation's own
            // node, also when `node` is the definition being spelled.
            let signatureFactsNode = if isDeclaringPart {
                declaringPartSignature!!.DeclaringSyntaxReferences[0].GetSyntax() as MethodDeclarationSyntax ?? node
            } else {
                node
            }
            let isPartialPart = isDeclaringPart ||
                (
                isOrdinaryMemberPosition &&
                    symbol?.PartialDefinitionPart is IMethodSymbol partialDefinition &&
                    this.IsEmittablePartialMethodPair(partialDefinition, ownerKind, out _)
            )
            // ADR-0192 follow-on 2: an implementing part whose declaring part
            // is the user's own G# (gsgen's stub), not a tree this run emits.
            // It pairs with no translated part, so it is not a tentative pair:
            // no PartialPairKey, and its parameters are spelled from the
            // implementation alone (reconciling would map the stub's
            // parameter syntax into this file).
            let isGeneratedImplementingPart = !isPartialPart &&
                isOrdinaryMemberPosition &&
                this.IsGeneratedImplementingPart(symbol, ownerKind)
            // Issue #1911 / #2010 / ADR-0149: C# `string IGreeter.Greet() { ... }`
            // (explicit interface implementation) has no direct G# surface
            // syntax spelled as an ordinary member name (ADR-0091 rejected an
            // `IFoo.M(this)` spelling for conflating with G#'s existing
            // extension-function sugar).
            //
            // When the implemented interface is a G# USER interface (declared in
            // this same C# source, so it translates to a G# `interface`), the
            // explicit implementation is emitted as its own distinct G# method
            // carrying an ADR-0149 explicit-interface qualifier clause
            // (`func (IGreeter) Greet(...)`), keeping its own plain member name
            // (`Greet`) — NOT a mangled name. gsc's binder resolves the clause's
            // interface type directly, verifies it is an implemented interface
            // with a matching member signature, and binds a CLR `MethodImpl` row
            // so each interface's dispatch slot routes to its own body (reusing
            // the ADR-0089 static-virtual / issue #985 bridge machinery). Since
            // the clause names the interface directly (not by mangling into the
            // identifier), two explicit implementations of the same member from
            // different user interfaces never collide on name — no drop, no
            // diagnostic, full fidelity, and each keeps its unqualified source
            // name for diagnostics/reflection/display.
            //
            // Issue #2822: imported CLR interfaces use the same clause. gsc can
            // resolve imported qualifier types and emit MethodImpl rows, so
            // dropping `IEnumerable.` from `IEnumerable.GetEnumerator()` is both
            // unnecessary and harmful: it creates two public GetEnumerator
            // methods distinguished only by return type.
            let isExplicitInterfaceImpl = symbol != nil && symbol.ExplicitInterfaceImplementations.Length > 0
            // Issue #2010 follow-up: Roslyn's ExplicitInterfaceImplementations
            // can hold MORE THAN ONE entry — this happens when the explicit
            // member also satisfies an inherited/re-declared same-signature
            // member on a BASE interface (e.g. `void IBar.M(){}` where
            // `interface IBar : IFoo` and IFoo already declares `M`). The
            // clause-based scheme below wires exactly ONE interface slot per
            // method, so it only applies when there is a SINGLE entry.
            // Fallback keeps the pre-#2010 (#1911) named/forced-public path:
            // the method keeps its plain name with no clause, and
            // gsc's ordinary implicit name+signature interface-dispatch matching
            // then satisfies every entry uniformly (no explicit MethodImpl row
            // needed).
            //
            // Issue #3814: an IMPORTED GENERIC interface used to fall back here
            // too, because gsc dropped every explicit implementation after the
            // first same-signature one from the type's overload set — so a class
            // explicitly implementing one member on TWO instantiations
            // (`IAsyncEnumerable<int>` and `IAsyncEnumerable<string>`) reported
            // the second interface unimplemented (GS0187). The fallback made that
            // strictly worse: with no clause the two methods differ only in
            // return type and collide as a duplicate overload (GS0264). gsc now
            // keeps both slots, so the clause is emitted for imported generic
            // interfaces as well.
            let hasSingleExplicitInterfaceImpl = isExplicitInterfaceImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length == 1
            let hasClauseCompatibleExplicitInterfaceImpl = hasSingleExplicitInterfaceImpl
            if isExplicitInterfaceImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length > 1 &&
                symbol!!
                .ExplicitInterfaceImplementations
                .All((e IMethodSymbol) -> e.ContainingType.Locations.Any((l Location) -> l.IsInSource)) {
                let names = string.Join(
                    ", ",
                    symbol!!.ExplicitInterfaceImplementations.Select((e IMethodSymbol) -> e.ContainingType.Name)
                )
                let multiEntryMessage = "explicit interface implementation '${FormatExplicitInterfaceName(symbol)}' satisfies more than one " +
                    "G# user interface member in one C# declaration ($names), likely via interface inheritance " +
                    "(a base interface re-declaring the same signature). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per method, so this falls back to the #1911 " +
                    "named/forced-public path instead of a clause — the method keeps its plain name and every " +
                    "interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: the " +
                    "method becomes publicly callable by name, unlike real C# explicit-impl semantics)."
                this.context.Report(
                    TranslationDiagnostic(
                        "MethodDeclaration",
                        multiEntryMessage,
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            if isExplicitInterfaceImpl && !hasClauseCompatibleExplicitInterfaceImpl {
                let survivor IMethodSymbol? = FindPriorCollidingSibling(symbol, node)
                if survivor != nil {
                    let message = "explicit interface implementation '${symbol!!.ContainingType.Name}.${FormatExplicitInterfaceName(symbol)}' " +
                        "shares its name and signature with '${symbol!!.ContainingType.Name}.${FormatSiblingName(survivor)}'; " +
                        "a G# explicit-interface clause cannot safely represent this interface shape, so the " +
                        "colliding C# methods cannot both be emitted (would be an exact-signature duplicate, GS0264). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's body differs from this dropped declaration's body, any C# " +
                        "call through the interface-typed reference that previously reached this body now silently " +
                        "observes the surviving method's body instead (semantic loss, known gap, issue #1911)."
                    this.context.Report(
                        TranslationDiagnostic(
                            "MethodDeclaration",
                            message,
                            node.GetLocation(),
                            TranslationSeverity.Unsupported
                        )
                    )
                    return (nil, false)
                }
            }
            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a clause-compatible explicit implementation, or null for an
            // ordinary method / safe fallback.
            let explicitInterfaceType GTypeReference? = if hasClauseCompatibleExplicitInterfaceImpl {
                this.typeMapper.Map(
                    symbol!!.ExplicitInterfaceImplementations[0].ContainingType,
                    this.context,
                    node.GetLocation()
                )
            } else {
                default(GTypeReference?)
            }
            var receiver Receiver? = nil
            var skipFirstParameter = false
            var ownedExtensionSelf IParameterSymbol? = nil
            if forcedReceiver != nil {
                // Issue #1879: a C# 14 `extension(T x) { ... }` block instance
                // member has no `this` parameter of its own — the receiver lives
                // on the enclosing extension-block declaration — so the caller
                // (TranslateExtensionBlock) resolves it there and threads it
                // through directly, bypassing the `IsExtensionMethod`-based
                // detection below (the block member's own declared symbol is a
                // synthetic marker with `IsExtensionMethod == false`). Maps to the
                // same receiver-clause `func` as a classic `this T x` extension
                // method (ADR-0115 §B.19).
                receiver = forcedReceiver
                isStatic = false
            } else if symbol != nil && symbol.IsExtensionMethod {
                let self IParameterSymbol? = symbol.Parameters.FirstOrDefault()
                if self != nil && ownedExtensionTarget != nil {
                    // Issue #2821: a same-package source receiver is owned by
                    // this output package. Emit the extension as an in-body
                    // member forwarding to the original static holder. Its body
                    // and private helpers retain their native declaring owner.
                    ownedExtensionSelf = self
                    skipFirstParameter = true
                    isStatic = false
                } else if self != nil && (forceExtensionReceiver || !this.IsStaticExtensionHelper(symbol)) {
                    // Issue #3357 / ADR-0182: enum receivers and source-owned
                    // receivers that cannot become real in-body members use
                    // the ordinary receiver-clause form, which is
                    // unconditionally an extension now — it preserves
                    // member-call syntax without making the declaration an
                    // owned instance method, with no marker needed.
                    // Issue #1072/#1535: an extension receiver that is null-compared
                    // or null-assigned in the body is really nullable (common in
                    // nullable-oblivious sources, e.g. `this object o => o == null`),
                    // so promote it to `T?` exactly as an ordinary parameter would be
                    // — the receiver path bypasses MapParameters, so the promotion
                    // must be applied here too.
                    var receiverType GTypeReference? = this.typeMapper.Map(self.Type, this.context, node.GetLocation())
                    receiverType = this.PromoteIfUsedAsNullable(receiverType, self)
                    receiver = Receiver(
                        this.EmittedName(self, self.Name),
                        receiverType,
                        this.MapParameterAttributes(self)
                    )
                    skipFirstParameter = true
                    isStatic = false
                }
            }
            var parameters = if isDeclaringPart {
                symbol!!
                    .Parameters
                    .Select(
                    (parameter IParameterSymbol, index int32) -> this.MapParameter(
                        parameter,
                        node.ParameterList,
                        spellingLocation: symbol!!.PartialDefinitionPart!!.Parameters[index].Locations.FirstOrDefault()
                    )
                )
                    .ToList()
            } else {
                this.MapParameters(symbol, node.ParameterList, skipFirstParameter)
            }
            if isPartialPart {
                parameters = this.ReconcilePartialMethodParameters(symbol, parameters, isDeclaringPart)
            } else if !isGeneratedImplementingPart && symbol?.PartialDefinitionPart != nil {
                parameters = this.ApplyPartialMethodDefinitionDefaults(
                    symbol,
                    parameters,
                    useDefinitionScope: false,
                    parameterOffset: if skipFirstParameter {
                        1
                    } else {
                        0
                    }
                )
            }
            let isOwnerScopedExtensionCompanion = ownedExtensionSelf != nil ||
                (forceExtensionReceiver && CSharpToGSharpTranslator.RequiresOwnerScopedExtension(symbol))
            // ADR-0174 D4: an `async ValueTask`/`ValueTask<T>` method that
            // touches the Gsharp.Concurrency runtime (or carries [Suspending])
            // is a G# `suspend func`; its return type is the awaited result,
            // exactly as B.23 unwraps `async Task<T>`.
            let isEmittedSuspend = symbol != nil && this.IsSuspendingCandidate(symbol, signatureFactsNode)
            if isEmittedSuspend && this.ownedExtensions.Contains(node) && !this.CanPreserveSuspendingExtensionSignature(
                symbol,
                signatureFactsNode
            ) {
                let message = "owned suspending extension '${symbol!!.ContainingType.Name}.${symbol!!.Name}' cannot retain " +
                    "its native static-holder signature: G# suspension would add a Context parameter " +
                    "absent from the original declaration (ADR-0174 D7)."
                this.context.ReportUnsupported(node, message)
                return (nil, false)
            }
            var returnType GTypeReference? = this.MapReturnType(
                symbol,
                node,
                unwrapValueTask: isEmittedSuspend,
                iteratorBodySource: signatureFactsNode,
                preserveEnvelope: isOwnerScopedExtensionCompanion && !isEmittedSuspend
            )
            let typeParameters = this.MapMethodTypeParameters(
                symbol,
                if isDeclaringPart {
                    symbol!!.PartialDefinitionPart
                } else {
                    default(IMethodSymbol?)
                }
            )
            // ADR-0192: the declaring part is signature-only — the
            // implementation's body is translated once, by the implementing
            // part, never here (a second translation would report its body
            // diagnostics twice).
            let hasBody = !isDeclaringPart && (node.Body != nil || node.ExpressionBody != nil)
            var body BlockStatement?
            var isAnalyzerHarness = false
            if hasBody && this.TryBuildAnalyzerHarnessBody(symbol, parameters, node, out var harnessBody) {
                body = harnessBody
                isAnalyzerHarness = true
                // The C# harness was `async Task`, which G# spells as an
                // `async func` with NO declared return type (the modifier
                // synthesizes the envelope). The rewrite drops `async`, so the
                // Task envelope has to come back explicitly — the migrated
                // [Fact] methods `return` this call.
                if returnType == nil && ReturnsTask(symbol) {
                    returnType = this.typeMapper.Map(symbol!!.ReturnType, this.context, node.GetLocation())
                }
            } else if hasBody && isOwnerScopedExtensionCompanion {
                let companionReceiver = receiver ??
                    Receiver(
                    this.EmittedName(ownedExtensionSelf, ownedExtensionSelf!!.Name),
                    this.typeMapper.Map(ownedExtensionSelf!!.Type, this.context, node.GetLocation())
                )
                body = this.BuildOwnerScopedExtensionCompanionBody(symbol, companionReceiver, parameters, returnType)
            } else {
                body = if hasBody {
                    this.TranslateBody(node, "method '${node.Identifier.Text}'")
                } else {
                    default(BlockStatement?)
                }
            }
            if body != nil && ownedExtensionSelf != nil {
                let statements = List[GStatement](body.Statements.Count + 1){LocalDeclarationStatement(
                        BindingKind.Var,
                        this.EmittedName(ownedExtensionSelf, ownedExtensionSelf.Name),
                        initializer: ThisExpression()
                    )
                }
                statements.AddRange(body.Statements)
                body = BlockStatement(statements)
            }
            // ADR-0122 / issue #1014: a C# `unsafe` method body is an unsafe
            // context. The G# member-level `unsafe func` modifier does not combine
            // with an accessibility keyword in the grammar, so — unless the whole
            // owning type is already `unsafe` — the body is wrapped in an
            // `unsafe { … }` block, which round-trips with any visibility and gives
            // the same unsafe context.
            if body != nil && node.Modifiers.Any(SyntaxKind.UnsafeKeyword) &&
                !node
                .Ancestors()
                .OfType[TypeDeclarationSyntax]()
                .Any((t TypeDeclarationSyntax) -> t.Modifiers.Any(SyntaxKind.UnsafeKeyword)) {
                body = BlockStatement([]GStatement{BlockStatement(body.Statements, isUnsafe: true)})
            }
            let isAsyncVoidHandler = IsCSharpAsyncVoidHandler(symbol)
            var isOverride = symbol != nil && symbol.IsOverride
            // Interface members are implicitly abstract in C#; in canonical G# the
            // members of an `interface` carry no modifier (the `open` keyword is for
            // virtual/abstract members of a class). Suppress `open` for them so the
            // emitted G# round-trips (ADR-0115 §B.6).
            var isOpen = this.IsMemberEmittedOpen(symbol, isOverride)
            // Receiver-clause methods have no `open`/`override`, and a value
            // aggregate has no open members of its own. A `data struct`
            // replaces its synthesized `ToString` with a plain `func` (ADR-0029
            // / #2361). Issue #4350: a plain struct's `override` of an
            // inherited `object` member (`Equals`, `GetHashCode`, `ToString`)
            // is KEPT — dropping it declared a new non-virtual method that hid
            // the override, so boxed equality and hashing silently fell back
            // to `ValueType`'s.
            if receiver != nil || ownerKind == TypeDeclarationKind.DataStruct {
                isOpen = false
                isOverride = false
            } else if IsValueAggregate(ownerKind) {
                isOpen = false
            }
            // Generic interface methods are supported by the G# parser since
            // issue #1007 (`func F[T](...) R;`); the printer emits the
            // type-parameter list via the same path as a class method or free
            // func, so the `[T]` clause is retained on interface methods.
            // Issue #1278 / ADR-0131: a C# expression-bodied method (`=> expr`)
            // renders as the idiomatic G# arrow form `func F(...) T -> expr`
            // when the translated body folds to a single inline statement.
            // Issue #2438: an async-void handler's wrapper body is never a
            // single foldable statement (it always needs the nested
            // async-literal binding plus the `ContinueWith` call), so it
            // never takes the arrow form.
            let arrowBody GStatement? = if !isAsyncVoidHandler &&
                ownerKind != TypeDeclarationKind.Interface &&
                body != nil &&
                node.ExpressionBody != nil {
                TryFoldArrowBody(body)
            } else {
                default(GStatement?)
            }
            if arrowBody != nil {
                body = nil
            }
            // Issue #2010/#2362/#2822, ADR-0149: a clause-compatible explicit
            // implementation now emits its own plain-named method carrying an
            // explicit-interface qualifier clause and is bound to its own CLR
            // interface slot via an explicit MethodImpl row at emit time — it
            // no longer relies on name-based virtual dispatch, so it can keep
            // C#'s own `private`-equivalent visibility (Roslyn reports
            // `DeclaredAccessibility` as `Private`: no accessibility keyword,
            // unreachable through the class type). This matches C# semantics,
            // where an explicit impl is not publicly callable by the type name.
            //
            // Fallbacks still rely on name-based dispatch and stay public.
            let explicitInterfaceVisibility = if isExplicitInterfaceImpl && !hasClauseCompatibleExplicitInterfaceImpl {
                Visibility.Default
            } else {
                MapVisibility(symbol, this.context, node)
            }
            // A rewritten analyzer test harness (#3686) delegates to the
            // synchronous G# verifier: there is nothing left to await, and an
            // `async` func returning `Task` cannot `return` a value.
            // Ordinary companions return the holder's envelope directly.
            // Suspension instead shares the hosted logical-result contract.
            let isEmittedAsync = !isOwnerScopedExtensionCompanion &&
                !isAnalyzerHarness &&
                !isEmittedSuspend &&
                symbol != nil &&
                symbol.IsAsync
            // Issue #4370: a `[LibraryImport]` definition's import arguments
            // are re-spelled from their constant values; issue #4301: so are
            // a `[GeneratedRegex]` definition's.
            let methodAttributes = if isNativeImportDefinition {
                this.MapLibraryImportMethodAttributes(node, symbol)
            } else {
                (
                    if isGeneratedRegexDefinition {
                        this.MapGeneratedRegexMethodAttributes(node, symbol)
                    } else {
                        this.MapAttributes(node.AttributeLists, isSuspendingDeclaration: isEmittedSuspend)
                    }
                )
            }
            // ADR-0192 §C: method-level attributes are unioned across the
            // parts by gsc, so each part carries only its OWN — `node` is the
            // C# definition for the declaring part (the pre-ADR-0192
            // implementation-only translation silently dropped its
            // attributes).
            let method = MethodDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: typeParameters,
                receiver: receiver,
                visibility: explicitInterfaceVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                isAsync: isEmittedAsync,
                attributes: methodAttributes,
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfaceType,
                isRefReturn: symbol != nil && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly),
                isReadOnlyRefReturn: symbol?.ReturnsByRefReadonly == true,
                isSuspend: isEmittedSuspend,
                isPartial: isPartialPart || isGeneratedImplementingPart || isGeneratedRegexDefinition,
                partialPairKey: if isPartialPart {
                    PartialPairKeyOf(symbol)
                } else {
                    default(string?)
                }
            )
            return (method, isStatic)
        }

        /// ADR-0143 2026-09-23 amendment / ADR-0192: whether the implemented
        /// C# partial method [`definition`](paramref) translates to a G#
        /// declaring part plus implementing part rather than to a single
        /// ordinary method. Evaluated identically from the definition node and
        /// from the implementation node, so the implementing part is marked
        /// `partial` exactly when the declaring part is emitted.
        /// @param definition The partial method's defining-part symbol.
        /// @param ownerKind The G# kind of the containing type.
        /// @param implementationNode The implementing part's declaration, when eligible.
        /// @returns `true` when both parts are emitted.
        private func IsEmittablePartialMethodPair(
            definition IMethodSymbol,
            ownerKind TypeDeclarationKind,
            out implementationNode MethodDeclarationSyntax?
        ) bool {
            implementationNode = nil
            // Legacy issue #1910 merge mode produces ONE non-partial G# type,
            // where a `partial func` is GS0608. Interfaces and inline structs
            // reject partial funcs (GS0607).
            if !this.emitPartialMethodPairs ||
                !this.preservePartialParts ||
                !CanDeclarePartialFunction(ownerKind) ||
                !definition.IsPartialDefinition ||
                definition.PartialImplementationPart is not IMethodSymbol implementation {
                return false
            }
            // A pair the reconciliation loop demoted (its parts spelled
            // different signatures): translate exactly as with pairs off.
            // Checked before anything is mapped, so the re-translated file
            // records no import or alias for the dropped declaring part.
            if this.suppressedPartialPairKeys?.Contains(PartialPairKeyOf(implementation)) == true {
                return false
            }
            // Shapes G# cannot spell as a partial method (ADR-0192 §F, GS0607):
            // cs2gs lowers an extension method to a receiver-clause func (or
            // moves it into its receiver type, issue #2821), and an explicit
            // interface implementation carries a qualifier clause. A partial
            // method of the hoisted C# entry class becomes a top-level func.
            // An `extern` implementation (a P/Invoke-style body) has no G#
            // implementing-part spelling.
            if definition.IsExtensionMethod ||
                implementation.IsExtern ||
                definition
                .ExplicitInterfaceImplementations
                .Length > 0 ||
                implementation
                .ExplicitInterfaceImplementations
                .Length > 0 ||
                (
                this.entryType != nil && SymbolEqualityComparer.Default.Equals(
                    definition.ContainingType?.OriginalDefinition,
                    this.entryType.OriginalDefinition
                )
            ) {
                return false
            }
            // C# only warns (CS8826) when the parts name a parameter
            // differently; G# requires identical names on both parts (GS0611),
            // and each name is observable to callers passing arguments by name.
            // There is no faithful G# spelling, so keep the pre-ADR-0192 shape.
            if definition
                .Parameters
                .Length != implementation
                .Parameters
                .Length ||
                definition
                .Parameters
                .Zip(implementation.Parameters, (d IParameterSymbol, i IParameterSymbol) -> d.Name == i.Name)
                .Any((sameName bool) -> !sameName) {
                return false
            }
            if definition
                .DeclaringSyntaxReferences
                .Length != 1 ||
                implementation
                .DeclaringSyntaxReferences
                .Length != 1 ||
                definition
                .DeclaringSyntaxReferences[0]
                .GetSyntax() is not MethodDeclarationSyntax definitionNode ||
                implementation
                .DeclaringSyntaxReferences[0]
                .GetSyntax() is not MethodDeclarationSyntax implNode {
                return false
            }
            // Both parts must be hand-authored source that this translation
            // emits. A part in a generated document is dropped by cs2gs and
            // regenerated at build by gsgen (ADR-0143 §A / ADR-0145) — the
            // common case is a generator-declared `partial void OnXChanged(T)`
            // hook with a user-written implementation — so emitting the other
            // part as `partial func` would leave it without its partner
            // (GS0610). See IsHandAuthoredTranslatedTree for the signal.
            if !this.IsHandAuthoredTranslatedTree(definitionNode.SyntaxTree) || !this.IsHandAuthoredTranslatedTree(
                implNode.SyntaxTree
            ) {
                return false
            }
            // Not a hand-authored pair: a `[GeneratedRegex]` definition
            // translates to a declaring part on its own (issue #4301), and its
            // implementation is generator output that gsgen regenerates, so a
            // translated implementation is dropped rather than paired. An
            // ADR-0169 analyzer test harness rewrite changes the
            // implementation's signature (drops `async`) in a way the
            // declaring part would not see.
            if CSharpToGSharpTranslator.IsGeneratedRegexDefinition(definition) || this.IsAnalyzerHarnessEntry(
                implementation
            ) ||
                this.IsAnalyzerHarnessSupportMemberInOwnTree(definitionNode) ||
                this.IsAnalyzerHarnessSupportMemberInOwnTree(implNode) {
                return false
            }
            // gsc requires both parts' signatures to be textually identical
            // (GS0611) and each to resolve in its own file. Each G# file's
            // imports and aliases are built per output file, so whether the two
            // files spell the signature the same way is only known once both
            // are translated: PartialMethodPairReconciler compares the printed
            // signatures afterwards and demotes a mismatched pair. A parameter
            // attribute is decided HERE instead: gsc requires the same
            // annotations on both parts, so a cross-file pair would copy one
            // file's attribute into the other file, where it can resolve to a
            // different type or add an import that breaks that file's own
            // code — a leak the post-pass cannot see. Within one file (one
            // type mapper) the union is safe.
            if definitionNode.SyntaxTree != implNode.SyntaxTree &&
                definition
                .Parameters
                .Concat(implementation.Parameters)
                .Any(HasParameterAttributes) {
                return false
            }
            implementationNode = implNode
            return true
        }

        /// ADR-0192 follow-on 2: whether [`implementation`](paramref) is a
        /// C# partial method implementation whose definition lives in a tree
        /// this translation does not emit — in gsgen, the stub rendered from
        /// the user's hand-written G# declaring part — so it translates to a
        /// G# implementing part (`partial func` with its body) that pairs
        /// with that declaring part at build time. Only with
        /// `emitGeneratedImplementingParts` on; every other caller keeps
        /// the ordinary-method shape. When both parts are in emitted trees
        /// this returns `false`, and the pair follows the
        /// ADR-0143 rules ((cref:IsEmittablePartialMethodPair)).
        /// @param implementation The method being translated.
        /// @param ownerKind The G# kind of the containing type.
        /// @returns `true` to emit the method as an implementing part.
        private func IsGeneratedImplementingPart(implementation IMethodSymbol?, ownerKind TypeDeclarationKind) bool {
            if !this.emitGeneratedImplementingParts ||
                !this.preservePartialParts ||
                !CanDeclarePartialFunction(ownerKind) ||
                implementation?.PartialDefinitionPart is not IMethodSymbol definition {
                return false
            }
            // Shapes G# cannot spell as a partial method (ADR-0192 §F), as in
            // IsEmittablePartialMethodPair.
            if definition.IsExtensionMethod ||
                implementation!!.IsExtern ||
                implementation!!
                .ExplicitInterfaceImplementations
                .Length > 0 ||
                (
                this.entryType != nil && SymbolEqualityComparer.Default.Equals(
                    definition.ContainingType?.OriginalDefinition,
                    this.entryType.OriginalDefinition
                )
            ) {
                return false
            }
            if definition.DeclaringSyntaxReferences.Length != 1 {
                return false
            }
            return !this.IsTranslatedByThisRun(definition.DeclaringSyntaxReferences[0].SyntaxTree)
        }

        // The two parts of a pair may live in different files, and this check
        // runs from either part's node, so it resolves symbols through the
        // node's OWN tree's semantic model.
        private func IsAnalyzerHarnessSupportMemberInOwnTree(method MethodDeclarationSyntax) bool {
            using let modelScope = this.context.UseSemanticModelFor(method.SyntaxTree)
            return this.IsAnalyzerHarnessSupportMember(method)
        }

        /// Whether [`tree`](paramref) is a hand-authored C# document this
        /// translation emits — the same file set `CSharpProjectLoader`
        /// keeps. When the caller supplies `retainedFilePaths` (a project
        /// with analyzer/generator references, issue #2215) the tree must be in
        /// it: source-generator output is excluded from that set. In every case
        /// the tree must not be build-generated by the loader's own rule
        /// ((cref:GeneratedSourceDetection.IsGeneratedSource): under the
        /// project's obj/bin directory, when the caller supplied it, or
        /// carrying the `<auto-generated>` header).
        private func IsHandAuthoredTranslatedTree(tree SyntaxTree?) bool -> (
            this.retainedFilePaths == nil || this.retainedFilePaths.Contains(tree!!.FilePath)
        ) &&
            !GeneratedSourceDetection.IsGeneratedSource(tree, this.projectDirectory)

        /// ADR-0192 §C/§D: both parts of a G# partial method must agree on every
        /// parameter's default value and annotations. The mapped parameters come
        /// from the implementation's symbols; this sets each default to the C#
        /// DEFINITION's — the one C# callers observe (a default written on the
        /// implementation is ignored, CS1066) — mapped in this part's own file,
        /// and each parameter's attributes to the union of both C# parts'
        /// attribute lists, definition first: C#'s own parameter-attribute rule
        /// (a non-AllowMultiple attribute on both parts is already CS0579), so
        /// the same list is emitted on both parts. IsEmittablePartialMethodPair
        /// only lets a pair carry parameter attributes when both parts are in
        /// ONE file (one type mapper), so the union never moves an attribute
        /// into another file.
        private func ReconcilePartialMethodParameters(
            symbol IMethodSymbol?,
            parameters List[Parameter],
            isDeclaringPart bool
        ) List[Parameter] {
            var parameters = parameters
            parameters = this.ApplyPartialMethodDefinitionDefaults(
                symbol,
                parameters,
                isDeclaringPart,
                parameterOffset: 0
            )
            let definition IMethodSymbol? = symbol!!.PartialDefinitionPart ?? symbol
            let reconciled = List[Parameter](parameters.Count)
            for var i = 0; i < parameters.Count; i++ {
                let mapped = parameters[i]
                let definitionParameter = definition!!.Parameters[i]
                let attributes = List[AttributeUse]()
                for part in[]IParameterSymbol{definitionParameter, symbol!!.Parameters[i]} {
                    if part.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is ParameterSyntax partSyntax {
                        attributes.AddRange(this.MapAttributes(partSyntax.AttributeLists))
                    }
                }
                reconciled.Add(
                    Parameter(
                        mapped.Name,
                        mapped.Type,
                        mapped.IsVariadic,
                        mapped.RefKind,
                        mapped.DefaultValue,
                        attributes
                    )
                )
            }
            return reconciled
        }

        private func ApplyPartialMethodDefinitionDefaults(
            implementation IMethodSymbol?,
            parameters List[Parameter],
            useDefinitionScope bool,
            parameterOffset int32
        ) List[Parameter] {
            let definition IMethodSymbol? = implementation!!.PartialDefinitionPart ?? implementation
            let reconciled = List[Parameter](parameters.Count)
            for var i = 0; i < parameters.Count; i++ {
                let mapped = parameters[i]
                let symbolIndex = i + parameterOffset
                let spellingParameter = if useDefinitionScope {
                    definition!!.Parameters[symbolIndex]
                } else {
                    implementation!!.Parameters[symbolIndex]
                }
                let spellingSyntax SyntaxNode? = spellingParameter
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax()
                let defaultValue GExpression? = this.BuildOptionalParameterDefault(
                    definition!!.Parameters[symbolIndex],
                    mapped.Type,
                    spellingSyntax,
                    spellingNode: spellingSyntax
                )
                reconciled.Add(
                    Parameter(
                        mapped.Name,
                        mapped.Type,
                        mapped.IsVariadic,
                        mapped.RefKind,
                        defaultValue,
                        mapped.Attributes
                    )
                )
            }
            return reconciled
        }

        private func BuildOwnerScopedExtensionCompanionBody(
            method IMethodSymbol?,
            receiver Receiver,
            parameters IReadOnlyList[Parameter],
            returnType GTypeReference?
        ) BlockStatement {
            let original IMethodSymbol? = method!!.ReducedFrom ?? method
            let arguments = List[GExpression](parameters.Count + 1){IdentifierExpression(receiver.Name)}
            for var index = 0; index < parameters.Count; index++ {
                var argument GExpression = IdentifierExpression(parameters[index].Name)
                if original!!
                    .Parameters[index + 1]
                    .RefKind == RefKind.Ref ||
                    original!!
                    .Parameters[index + 1]
                    .RefKind == RefKind.Out {
                    argument = UnaryExpression("&", argument)
                }
                arguments.Add(argument)
            }
            let typeArguments IReadOnlyList[GTypeReference] = original!!
                .TypeParameters
                .Select(
                (parameter ITypeParameterSymbol) -> cast[GTypeReference](
                    NamedTypeReference(this.EmittedName(parameter, parameter.Name))
                )
            )
                .ToList()
            let call = InvocationExpression(
                MemberAccessExpression(
                    IdentifierExpression(this.EmittedName(original!!.ContainingType, original!!.ContainingType.Name)),
                    this.EmittedName(original, original!!.Name)
                ),
                arguments,
                typeArguments
            )
            let statement GStatement = if returnType == nil {
                cast[GStatement](ExpressionStatement(call))
            } else {
                cast[GStatement](
                    ReturnStatement(call, isRef: original!!.ReturnsByRef || original!!.ReturnsByRefReadonly)
                )
            }
            return BlockStatement([]GStatement{statement})
        }

        /// Translates the top-level forwarding companion of an owner-scoped extension. It sits
        /// outside the owner, so a source attribute that names one of the owner's private
        /// nested types (as the attribute class or in an argument) cannot resolve there; it is
        /// left off the companion, in every position (method, return value, parameter), and
        /// stays on the in-owner helper. Every other attribute is copied as before.
        /// @param method The extension's declaration.
        /// @param ownerKind The G# kind of the owner.
        /// @param symbol The extension's symbol.
        /// @returns The translated companion and whether it is static.
        private func TranslateOwnerScopedCompanion(
            method MethodDeclarationSyntax,
            ownerKind TypeDeclarationKind,
            symbol IMethodSymbol
        )(Member GMember?, IsStatic bool) {
            let privateTypeAttributes = CSharpToGSharpTranslator.AttributeApplicationsNamingPrivateNestedType(symbol)
            let previous((AttributeSyntax) -> bool)? = this.attributeOmission
            if privateTypeAttributes.Count > 0 {
                this.attributeOmission = (attribute AttributeSyntax) -> privateTypeAttributes.Contains(attribute)
            }
            try {
                return this.TranslateMethod(method, ownerKind, forceExtensionReceiver: true)
            } finally {
                this.attributeOmission = previous
            }
        }

        private func HasReceiverCompanion(method IMethodSymbol?) bool {
            let original IMethodSymbol? = method?.ReducedFrom ?? method
            if original != nil && original.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is MethodDeclarationSyntax declaration &&
                    this
                    .ownedExtensions
                    .Contains(declaration) && !this.CanPreserveSuspendingExtensionSignature(original, declaration)
            ) {
                return false
            }
            if this.IsPreservedOwnedExtension(method) &&
                (method?.ReducedFrom ?? method)!!.DeclaredAccessibility != Accessibility.Private {
                return false
            }
            if !this.ownedExtensions.HasReceiverCompanion(method) {
                return false
            }
            return !CSharpToGSharpTranslator.RequiresOwnerScopedExtension(original) ||
                this.CanEmitOwnerScopedReceiverCompanion(original)
        }

        private func CanEmitOwnerScopedReceiverCompanion(method IMethodSymbol?) bool {
            let original IMethodSymbol? = method?.ReducedFrom ?? method
            if !CSharpToGSharpTranslator.IsOwnerScopedCompanionShapeEligible(original) {
                return false
            }
            if original!!
                .Parameters[0]
                .Type is INamedTypeSymbol receiver &&
                this.HasCanonicalReducedDeclarationCollision(receiver.OriginalDefinition, original) {
                return false
            }
            let signature = this.CanonicalExtensionSignature(original)
            let identity = ExtensionMethodIdentity(original)
            let ownerCandidates = HashSet[string](StringComparer.Ordinal){identity}
            // A referenced project wins over its dependent: the dependency can
            // emit without knowing reverse dependents exist, while the dependent
            // sees the dependency through SiblingCompilations. Assembly + doc ID
            // deduplicates that source method's metadata copy.
            for candidate in this.EnumerateKnownExtensionMethods(original) {
                let candidateOriginal = candidate.ReducedFrom ?? candidate
                let candidateIdentity = ExtensionMethodIdentity(candidateOriginal)
                if candidateIdentity == identity || this.CanonicalExtensionSignature(candidateOriginal) != signature {
                    continue
                }
                if !CSharpToGSharpTranslator.RequiresOwnerScopedExtension(candidateOriginal) {
                    return false
                }
                if CSharpToGSharpTranslator.IsOwnerScopedCompanionShapeEligible(candidateOriginal) {
                    if CompilationReferencesAssembly(this.context.Compilation, candidateOriginal.ContainingAssembly) {
                        return false
                    }
                    let candidateCompilation CSharpCompilation? = this.KnownCompilations().FirstOrDefault(
                        (compilation CSharpCompilation) -> SameAssembly(
                            compilation.Assembly,
                            candidateOriginal.ContainingAssembly
                        )
                    )
                    if candidateCompilation != nil &&
                        CompilationReferencesAssembly(candidateCompilation, this.context.Compilation.Assembly) {
                        continue
                    }
                    ownerCandidates.Add(candidateIdentity)
                }
            }
            return string.Equals(identity, ownerCandidates.Min(StringComparer.Ordinal), StringComparison.Ordinal)
        }

        private func HasCanonicalReducedDeclarationCollision(receiver INamedTypeSymbol, extension IMethodSymbol?) bool {
            let extensionSignature = this.CanonicalReducedSignature(extension, parameterOffset: 1)
            let emittedName string? = this.EmittedName(extension, extension!!.Name)
            for var current INamedTypeSymbol? = receiver; current != nil; current = current!!.BaseType {
                for method in current.GetMembers().OfType[IMethodSymbol]() {
                    if !method.IsStatic && this.EmittedName(method, method.Name) == emittedName &&
                        this.CanonicalReducedSignature(method, parameterOffset: 0) == extensionSignature {
                        return true
                    }
                }
            }
            return false
        }

        private func EnumerateKnownExtensionMethods(method IMethodSymbol?) sequence[IMethodSymbol] {
            let namespaceName = method!!.ContainingNamespace?.ToDisplayString() ?? string.Empty
            let emittedName string? = this.EmittedName(method, method!!.Name)
            let seen = HashSet[string](StringComparer.Ordinal)
            for type in method!!.ContainingNamespace.GetTypeMembers() {
                for candidate in type.GetMembers().OfType[IMethodSymbol]() {
                    if candidate.IsExtensionMethod && this.EmittedName(candidate, candidate.Name) == emittedName &&
                        seen.Add(ExtensionMethodIdentity(candidate)) {
                        yield candidate
                    }
                }
            }
            for compilation in this.KnownCompilations() {
                let package_ INamespaceSymbol? = FindNamespace(compilation.Assembly.GlobalNamespace, namespaceName)
                if package_ == nil {
                    continue
                }
                for type in package_.GetTypeMembers() {
                    for candidate in type.GetMembers().OfType[IMethodSymbol]() {
                        if candidate.IsExtensionMethod && this.EmittedName(candidate, candidate.Name) == emittedName &&
                            seen.Add(ExtensionMethodIdentity(candidate)) {
                            yield candidate
                        }
                    }
                }
            }
        }

        private func KnownCompilations() IEnumerable[CSharpCompilation] -> []CSharpCompilation{this.context.Compilation}
            .Concat(this.context.SiblingCompilations ?? Array.Empty[CSharpCompilation]())
            .Concat(this.context.RepositoryCompilations ?? Array.Empty[CSharpCompilation]())
            .Distinct()

        private func CanonicalExtensionSignature(method IMethodSymbol?) string -> this.CanonicalEmittedType(
            method!!.Parameters[0].Type,
            method
        ) +
            "|" +
            this.CanonicalReducedSignature(method, parameterOffset: 1)

        private func CanonicalReducedSignature(method IMethodSymbol?, parameterOffset int32) string {
            let parts = List[string]{
                this.EmittedName(method, method!!.Name)!!,
                method!!.TypeParameters.Length.ToString(CultureInfo.InvariantCulture)
            }
            for var index = parameterOffset; index < method!!.Parameters.Length; index++ {
                let parameter = method!!.Parameters[index]
                parts.Add(
                    parameter.RefKind.ToString() +
                        ":" +
                        (
                        if parameter.IsParams {
                            "params:"
                        } else {
                            string.Empty
                        }
                    ) +
                        this.CanonicalEmittedType(parameter.Type, method)
                )
            }
            return string.Join("|", parts)
        }

        private func CanonicalEmittedType(type ITypeSymbol, method IMethodSymbol?) string {
            // Collision probing must not add imports or unsupported diagnostics
            // to the real translation (e.g. an Index-typed unrelated overload).
            let signatureContext = TranslationContext(
                this.context.Compilation,
                this.context.SemanticModel,
                this.context.FilePath,
                this.context.SiblingCompilations,
                this.context.RepositoryCompilations
            )
            let signatureMapper = CSharpTypeMapper(AnonymousTypeRegistry(), this.nameAllocator)
            let mapped GTypeReference? = signatureMapper.Map(type, signatureContext, Location.None)
            var rendered = GSharpPrinter.RenderTypeReference(mapped).Replace(
                "?",
                string.Empty,
                StringComparison.Ordinal
            )
            for parameter in method!!.TypeParameters {
                let name = Regex.Escape(this.EmittedName(parameter, parameter.Name)!!)
                rendered = Regex.Replace(
                    rendered,
                    "(?<![\\p{L}\\p{N}_])$name(?![\\p{L}\\p{N}_])",
                    "!" + parameter.Ordinal.ToString(CultureInfo.InvariantCulture)
                )
            }
            return rendered
        }

        private func IsPreservedOwnedExtension(method IMethodSymbol?) bool {
            let original IMethodSymbol? = method?.ReducedFrom ?? method
            if original?.IsExtensionMethod == true && !SymbolEqualityComparer.Default.Equals(
                original!!.ContainingAssembly,
                this.context.Compilation.Assembly
            ) {
                let owner CSharpCompilation? = this
                    .KnownCompilations()
                    .Concat(
                    this
                        .context
                        .Compilation
                        .References
                        .OfType[CompilationReference]()
                        .Select((reference CompilationReference) -> reference.Compilation)
                        .OfType[CSharpCompilation]()
                )
                    .FirstOrDefault(
                    (compilation CSharpCompilation) -> SameAssembly(compilation.Assembly, original!!.ContainingAssembly)
                )
                let id string? = original!!.OriginalDefinition.GetDocumentationCommentId()
                if owner != nil && id != nil && DocumentationCommentId.GetFirstSymbolForDeclarationId(
                    id,
                    owner
                ) is IMethodSymbol declared &&
                    declared
                    .DeclaringSyntaxReferences
                    .FirstOrDefault() is SyntaxReference reference {
                    // Ask the declaring project's registry and eligibility reader,
                    // including its body-based suspension/nullability context.
                    let ownerContext = TranslationContext(
                        owner,
                        owner.GetSemanticModel(reference.SyntaxTree),
                        reference.SyntaxTree.FilePath,
                        this.context.SiblingCompilations,
                        this.context.RepositoryCompilations
                    )
                    let ownerVisitor = DeclarationVisitor(
                        ownerContext,
                        this.typeMapper,
                        subclassedBases: nil,
                        staticUsingTargets: nil,
                        entryPoint: nil,
                        keptTopLevelProgram: nil,
                        partialTypeParts: nil,
                        CSharpToGSharpTranslator.GetOrCollectOwnedExtensions(owner),
                        this.nameAllocator,
                        widenObliviousReferenceFields: this.widenObliviousReferenceFields
                    )
                    return ownerVisitor.IsPreservedOwnedExtension(declared)
                }
            }
            return original != nil && original.DeclaringSyntaxReferences.Any(
                (reference SyntaxReference) -> reference.GetSyntax() is MethodDeclarationSyntax declaration &&
                    this
                    .ownedExtensions
                    .Contains(declaration) &&
                    (
                    original.DeclaredAccessibility == Accessibility.Private || this.CanLowerOwnedExtension(declaration)
                )
            )
        }

        private func IsStaticExtensionHelper(method IMethodSymbol?) bool {
            if this.IsPreservedOwnedExtension(method) || this.ownedExtensions.IsStaticHelper(method) {
                return true
            }
            let original IMethodSymbol? = method?.ReducedFrom ?? method
            if !CSharpToGSharpTranslator.RequiresOwnerScopedExtension(original) ||
                this
                .context
                .SiblingCompilations == nil {
                return false
            }
            // Reproduce the owner-scoped declaration only for projects translated
            // in this run. Third-party metadata may also contain private nested
            // implementation types, but its imported extension remains external.
            let assemblyName string? = original!!.ContainingAssembly?.Identity.GetDisplayName()
            return assemblyName != nil && this.context.SiblingCompilations!!.Any(
                (compilation CSharpCompilation) -> string.Equals(
                    compilation.Assembly.Identity.GetDisplayName(),
                    assemblyName,
                    StringComparison.Ordinal
                )
            )
        }

        /// Translates a C# operator overload (`public static X operator +(X a, X b)`)
        /// to the canonical G# receiver-clause operator form
        /// `func (a X) operator +(b X) X` (ADR-0035, sample `Operators.gs`;
        /// ADR-0115 §B.5). The first operand becomes the receiver; remaining
        /// operands become parameters (a unary operator has no parameters). The
        /// declaration is lifted to a top-level sibling because a receiver-clause
        /// `func` only binds at top level.
        ///
        /// C# 14 instance compound-assignment operators (`operator +=` and
        /// siblings, `op_AdditionAssignment` etc.) are NOT binary operators:
        /// they are instance, `void`-returning, single-parameter methods
        /// that mutate the receiver in place. gsc issue #2834 gives them a
        /// canonical G# spelling as an ordinary IN-BODY member —
        /// `public func operator +=(amount int32) { … }` — which round-trips
        /// to the same `specialname` instance `op_*Assignment` metadata
        /// Roslyn emits. They therefore keep their C# shape verbatim and are NOT
        /// lifted to a top-level receiver-clause sibling.
        private func TranslateOperator(node OperatorDeclarationSyntax)(Member GMember, IsStatic bool) {
            let operatorToken = node.OperatorToken.Text
            let symbol IMethodSymbol? = this.context.GetDeclaredSymbol(node) as IMethodSymbol
            if IsCompoundAssignmentOperatorToken(node.OperatorToken.Kind()) {
                return (this.TranslateCompoundAssignmentOperator(node, operatorToken, symbol), false)
            }
            let allParameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false)
            var receiver Receiver
            var parameters List[Parameter]
            if allParameters.Count > 0 {
                let first = allParameters[0]
                receiver = Receiver(first.Name, first.Type, first.Attributes)
                parameters = allParameters.Skip(1).ToList()
            } else {
                receiver = Receiver("self", NamedTypeReference(symbol?.ContainingType?.Name ?? "object"))
                parameters = List[Parameter]()
            }
            let returnType GTypeReference? = if symbol != nil {
                this.typeMapper.Map(symbol.ReturnType, this.context, node.ReturnType.GetLocation())
            } else {
                default(GTypeReference?)
            }
            var body BlockStatement? = if (node.Body != nil || node.ExpressionBody != nil) {
                this.TranslateBody(node, "operator '$operatorToken'")
            } else {
                default(BlockStatement?)
            }
            let arrowBody GStatement? = if node.ExpressionBody != nil {
                TryFoldArrowBody(body)
            } else {
                default(GStatement?)
            }
            if arrowBody != nil {
                body = nil
            }
            let method = MethodDeclaration(
                "operator $operatorToken",
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: nil,
                receiver: receiver,
                visibility: Visibility.Default,
                isOpen: false,
                isOverride: false,
                isAsync: false,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody
            )
            // Operators carry the receiver-clause form and are lifted to a top-level
            // sibling; returning IsStatic=false routes them through the existing
            // receiver-clause lift in VisitAggregate.
            return (method, false)
        }

        /// gsc issue #2834: translates a C# 14 instance compound-assignment
        /// operator (`public void operator +=(int amount)`) to the canonical
        /// G# in-body member `public func operator +=(amount int32) { … }`.
        /// Unlike a binary operator this keeps its C# shape exactly — instance,
        /// `void`, one parameter — and is not lifted to a receiver-clause
        /// sibling, so it round-trips to the same `specialname` instance
        /// `op_*Assignment` metadata Roslyn emits and consumes.
        private func TranslateCompoundAssignmentOperator(
            node OperatorDeclarationSyntax,
            operatorToken string,
            symbol IMethodSymbol?
        ) MethodDeclaration {
            let parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false)
            var body BlockStatement? = if (node.Body != nil || node.ExpressionBody != nil) {
                this.TranslateBody(node, "operator '$operatorToken'")
            } else {
                default(BlockStatement?)
            }
            let arrowBody GStatement? = if node.ExpressionBody != nil {
                TryFoldArrowBody(body)
            } else {
                default(GStatement?)
            }
            if arrowBody != nil {
                body = nil
            }
            return MethodDeclaration(
                "operator $operatorToken",
                parameters: parameters,
                returnType: nil,
                body: body,
                typeParameters: nil,
                receiver: nil,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: false,
                isOverride: false,
                isAsync: false,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody
            )
        }

        private func TranslateConversionOperator(node ConversionOperatorDeclarationSyntax)(
            Member GMember,
            IsStatic bool
        ) {
            // gsc issue #1017: `public static implicit operator T(U x)` →
            // `func operator implicit (x U) T { ... }` (and `explicit` likewise).
            // The single C# parameter is the conversion source; the C# target type
            // (`node.Type`) becomes the G# return type. `implicit`/`explicit` is a
            // contextual keyword that forms the operator name.
            let kindKeyword = if node.ImplicitOrExplicitKeyword.IsKind(SyntaxKind.ImplicitKeyword) {
                "implicit"
            } else {
                "explicit"
            }
            let symbol IMethodSymbol? = this.context.GetDeclaredSymbol(node) as IMethodSymbol
            let parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false)
            let returnType GTypeReference? = if symbol != nil {
                this.typeMapper.Map(symbol.ReturnType, this.context, node.Type.GetLocation())
            } else {
                this.MapTypeSyntax(node.Type)
            }
            var body BlockStatement? = if (node.Body != nil || node.ExpressionBody != nil) {
                this.TranslateBody(node, "conversion operator '$kindKeyword'")
            } else {
                default(BlockStatement?)
            }
            let arrowBody GStatement? = if node.ExpressionBody != nil {
                TryFoldArrowBody(body)
            } else {
                default(GStatement?)
            }
            if arrowBody != nil {
                body = nil
            }
            let method = MethodDeclaration(
                "operator $kindKeyword",
                parameters: parameters,
                returnType: returnType,
                body: body,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody
            )
            // The conversion operator has no receiver clause, so it stays an
            // in-body member of the owning type (returning IsStatic=false routes it
            // to the instance-member list in VisitAggregate, which the parser
            // accepts directly in the type body).
            return (method, false)
        }

        /// Issue #2665: preserves the CLR property ABI of an initialized static
        /// auto-property by lowering only its storage to an initialized backing
        /// field and keeping a computed property over that field.
        private func TryTranslateStaticInitializedAutoProperty(
            node PropertyDeclarationSyntax,
            attributes List[AttributeUse],
            out field FieldDeclaration?,
            out property PropertyDeclaration?
        ) bool {
            let AccessorVisibility = func (accessor AccessorDeclarationSyntax) Visibility {
                if accessor.Modifiers.Count == 0 {
                    return Visibility.Default
                }
                return MapVisibility(this.context.GetDeclaredSymbol(accessor), this.context, accessor)
            }
            field = nil
            property = nil
            if !node.Modifiers.Any(SyntaxKind.StaticKeyword) || node.Initializer == nil {
                return false
            }
            // Auto-property: body-less, all accessors body-less, no expression body.
            if node.ExpressionBody != nil || node.AccessorList == nil {
                return false
            }
            let accessors IReadOnlyList[AccessorDeclarationSyntax] = node.AccessorList!!.Accessors
            if accessors.Any((a AccessorDeclarationSyntax) -> a.Body != nil || a.ExpressionBody != nil) {
                return false
            }
            let hasGet = accessors.Any((a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.GetAccessorDeclaration))
            if !hasGet {
                return false
            }
            let hasSet = accessors.Any((a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.SetAccessorDeclaration))
            let symbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            if symbol == nil {
                return false
            }
            var type GTypeReference? = this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
            var initializer GExpression? = this.CoerceConstantToUnsigned(
                node.Initializer!!.Value,
                this.TranslateNullSeamExpression(node.Initializer!!.Value)
            )
            initializer = this.ForgiveNullableReferenceValue(node.Initializer!!.Value, initializer, symbol.Type, symbol)
            // Issue #1072: a non-nullable reference static auto-property whose
            // initializer is nullable (e.g. `GetAttribute<...>()?.Member`) is
            // rendered `T?` so the initializer assignment type-checks.
            type = this.PromoteIfInitializerNullable(type, symbol, node.Initializer!!.Value)
            let binding = if hasSet {
                BindingKind.Var
            } else {
                BindingKind.Let
            }
            let backingName = this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames: nil)
            field = FieldDeclaration(
                binding,
                backingName,
                type,
                initializer: initializer,
                visibility: Visibility.Private
            )
            let propertyAccessors = List[PropertyAccessor]{
                PropertyAccessor(
                    Cs2Gs.CodeModel.Ast.AccessorKind.Get,
                    BlockStatement(List[GStatement]{ReturnStatement(IdentifierExpression(backingName))}),
                    visibility: AccessorVisibility(
                        accessors.First((a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.GetAccessorDeclaration))
                    )
                )
            }
            if hasSet {
                propertyAccessors.Add(
                    PropertyAccessor(
                        Cs2Gs.CodeModel.Ast.AccessorKind.Set,
                        BlockStatement(
                            List[GStatement]{
                                AssignmentStatement(IdentifierExpression(backingName), IdentifierExpression("value"))
                            }
                        ),
                        visibility: AccessorVisibility(
                            accessors.First(
                                (a AccessorDeclarationSyntax) -> a.IsKind(SyntaxKind.SetAccessorDeclaration)
                            )
                        )
                    )
                )
            }
            property = PropertyDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                type,
                propertyAccessors,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: attributes
            )
            return true
        }

        private func TranslateProperty(
            node PropertyDeclarationSyntax,
            attributes List[AttributeUse],
            primaryCtorParamNames IReadOnlyCollection[string]? = nil
        )(Member GMember?, IsStatic bool, BackingField GMember?) {
            let symbol IPropertySymbol? = this.context.GetDeclaredSymbol(node) as IPropertySymbol
            let isExplicitPositionalAutoProperty = IsExplicitPositionalAutoProperty(node, symbol)
            // Issue #3879 (ADR-0060 amendment): a C# `ref` PROPERTY now HAS a
            // canonical G# form — `prop P ref T { get { return ref lvalue } }`
            // and its arrow sugar `prop P ref T -> lvalue`. gsc restricts it to
            // the computed, read-only shapes. The read-only half is free — C#
            // forbids a setter on a ref property too (CS8147) — but the COMPUTED
            // half is not: C# also allows abstract and interface `ref`
            // properties, which gsc rejects, so the two gaps below carry the
            // difference. Before #3879 this gapped entirely, which
            // was the right interim answer: the alternative was emitting an
            // ordinary `prop P T` that silently returns a COPY (issue #3839).
            //
            // Issue #4220 preserves readonly capability separately from byref shape.
            var isRefReturnProperty = symbol != nil && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly)
            // Issue #3879: gsc restricts the by-ref property to the CONCRETE,
            // computed shapes — an abstract slot and an interface member (bodied
            // default implementations included) are both rejected with GS0578,
            // because neither names storage a reference can point at and G# has
            // no ref-kind matching for property slots. C# permits both, so the
            // mapping is NOT total and this is where the difference has to be
            // reported. Without it cs2gs emitted `prop P ref T` that gsc then
            // refused, turning a translate-stage gap into a compile-stage
            // failure several steps downstream — the opposite of the loud,
            // local answer #3839/#3878 established.
            if symbol != nil &&
                isRefReturnProperty &&
                (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface) {
                let abstractRefPropertyMessage = "ref-returning property '${node.Identifier.Text}' is abstract or declared on an interface, which " +
                    "has no G# form: G#'s by-ref property (issue #3879, ADR-0060 §14) is a concrete, computed-getter " +
                    "form only, because a slot names nothing to alias and an implementor could satisfy a `ref` " +
                    "requirement with a copy-returning property unchecked. A concrete `ref` property translates."
                this.context.ReportUnsupported(node, abstractRefPropertyMessage)
                isRefReturnProperty = false
            }
            // Issue #2362, ADR-0149: explicit interface PROPERTY implementations
            // get the exact same treatment as explicit interface METHODS (issues
            // #1911/#2010/#2181) — see the extensive comment on this same
            // decision tree in TranslateMethod, which this mirrors verbatim
            // (explicit-interface qualifier clause + CLR MethodImpl bridge).
            // Source and imported CLR interfaces use the same clause. The
            // property-specific difference: there is
            // no covariant-return "bridge" mechanism for properties (issue #985
            // has no property analogue), so collision detection never exempts
            // a type mismatch — see FindPriorCollidingSiblingProperty.
            let isExplicitInterfacePropertyImpl = symbol != nil && symbol.ExplicitInterfaceImplementations.Length > 0
            let usesExplicitInterfacePropertyClause = isExplicitInterfacePropertyImpl &&
                symbol!!
                .ExplicitInterfaceImplementations
                .Length == 1
            if isExplicitInterfacePropertyImpl &&
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
                let multiEntryMessage = "explicit interface property implementation '${FormatExplicitInterfacePropertyName(symbol)}' satisfies " +
                    "more than one G# user interface member in one C# declaration ($names), likely via interface " +
                    "inheritance (a base interface re-declaring the same property). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per property, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the property keeps its plain name " +
                    "and every interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: " +
                    "the property becomes publicly callable by name, unlike real C# explicit-impl semantics)."
                this.context.Report(
                    TranslationDiagnostic(
                        "PropertyDeclaration",
                        multiEntryMessage,
                        node.GetLocation(),
                        TranslationSeverity.Info
                    )
                )
            }
            if isExplicitInterfacePropertyImpl && !usesExplicitInterfacePropertyClause {
                let propertySurvivor IPropertySymbol? = FindPriorCollidingSiblingProperty(symbol, node)
                if propertySurvivor != nil {
                    let message = "explicit interface property implementation '${symbol!!.ContainingType.Name}.${FormatExplicitInterfacePropertyName(symbol)}' " +
                        "shares its name and signature with '${symbol!!.ContainingType.Name}.${FormatSiblingPropertyName(propertySurvivor)}'; " +
                        "one C# declaration targets multiple interface slots, while ADR-0149 carries one qualifier, so the " +
                        "two properties cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "access through the interface-typed reference that previously reached this property now " +
                        "silently observes the surviving property instead (semantic loss, known gap, issue #1911 " +
                        "analogue). Separate explicit declarations with distinct qualifiers are fully supported (issue " +
                        "#2362, ADR-0149 explicit-interface clause)."
                    this.context.Report(
                        TranslationDiagnostic(
                            "PropertyDeclaration",
                            message,
                            node.GetLocation(),
                            TranslationSeverity.Unsupported
                        )
                    )
                    return (nil, false, nil)
                }
            }
            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a single-slot explicit property implementation, or null otherwise.
            let explicitInterfacePropertyType GTypeReference? = if usesExplicitInterfacePropertyClause {
                this.typeMapper.Map(
                    symbol!!.ExplicitInterfaceImplementations[0].ContainingType,
                    this.context,
                    node.GetLocation()
                )
            } else {
                default(GTypeReference?)
            }
            let isStatic = symbol != nil && symbol.IsStatic
            var type GTypeReference? = if symbol != nil {
                this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
            } else {
                cast[GTypeReference](NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType))
            }
            // Issue #1354 / #1072: a non-nullable reference property that is
            // null-checked or null-assigned anywhere in the declaring type is
            // really nullable; render it `T?` so the `== nil`/`is null` guard
            // reads honestly (the guard itself is legal on any reference type).
            if symbol != nil {
                type = this.PromoteIfUsedAsNullable(type, symbol)
                if node.Initializer != nil {
                    type = this.PromoteIfInitializerNullable(type, symbol, node.Initializer!!.Value)
                }
                // Issue #3848 (family B): a generated `T[]` property written a
                // maybe-null ELEMENT renders `[]T?` — `Command.Arguments`,
                // written `[uri, range.Start]` with `uri` a `string?`.
                type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol)
            }
            // Issue #1907: register a synthesized backing field BEFORE mapping the
            // accessor bodies below, so a `field` reference inside them (bound via
            // TranslateExpression's FieldExpressionSyntax case) resolves to it.
            var fieldKeywordBackingName string? = this.TryRegisterFieldKeywordBackingField(
                node,
                symbol,
                primaryCtorParamNames,
                out var fieldKeywordBackingSymbol
            )
            let lowersToBackingField = symbol != nil && this.IsBackingFieldLoweredGetOnlyAutoProperty(symbol)
            if fieldKeywordBackingName == nil && lowersToBackingField {
                fieldKeywordBackingName = this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames)
            } else if fieldKeywordBackingName == nil &&
                !isStatic &&
                (node.Initializer != nil || isExplicitPositionalAutoProperty) &&
                (
                !IsGetOnlyAutoProperty(node) || symbol?.ContainingType?.IsRecord == true || symbol?.IsOverride == true
            ) &&
                (
                isExplicitPositionalAutoProperty ||
                    node.Initializer == nil ||
                    !IsNullOrSuppressedNull(node.Initializer!!.Value)
            ) {
                fieldKeywordBackingName = this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames)
            }
            // Issue #1907 / #1072: the backing field can be used as nullable
            // independently of the property's own declared nullability (e.g.
            // `get => field ??= "default";` lazy-inits a non-null-looking `string`
            // property from a field that starts out null) — promote off the
            // FIELD symbol's own usage, not the property's.
            let backingType GTypeReference? = if fieldKeywordBackingSymbol != nil {
                this.PromoteIfUsedAsNullable(type, fieldKeywordBackingSymbol)
            } else {
                type
            }
            // Issue #1907: a property initializer (`{ get; set => ...; } = 5;`)
            // seeds the compiler-synthesized backing field, not the property
            // itself — carry it over or the field silently starts at default(T).
            var backingInitializer GExpression? = if fieldKeywordBackingName != nil && node.Initializer != nil {
                this.CoerceConstantToUnsigned(
                    node.Initializer!!.Value,
                    this.TranslateNullSeamExpression(node.Initializer!!.Value)
                )
            } else {
                default(GExpression?)
            }
            // Issue #3635: an initializer reading a member of a nullability-
            // OBLIVIOUS assembly (e.g. netstandard2.0's `bool.TrueString` or
            // `Array.Empty<T>()`) is imported by gsc as `T?` (#1354), while the
            // backing field itself stays the declared non-null `T`. Bridge with
            // `!!` exactly as the static auto-property and plain-field
            // initializer paths already do (GS0155/GS0156 otherwise). A backing
            // type already rendered nullable needs no bridge.
            if backingInitializer != nil && (backingType != nil && backingType.IsNullable == false) {
                backingInitializer = this.ForgiveNullableReferenceValue(
                    node.Initializer!!.Value,
                    backingInitializer,
                    symbol?.Type,
                    symbol
                )
            }
            let backingField GMember? = if fieldKeywordBackingName != nil {
                FieldDeclaration(
                    BindingKind.Var,
                    fieldKeywordBackingName,
                    backingType,
                    initializer: backingInitializer,
                    visibility: Visibility.Private
                )
            } else {
                default(FieldDeclaration?)
            }
            var accessors = this.MapAccessors(node, fieldKeywordBackingName)
            // Issue #1278 / ADR-0131: a C# expression-bodied read-only property
            // (`string Name => expr;`) renders as the idiomatic G# property-level
            // arrow `prop Name T -> expr` when its get body folds to a single
            // inline statement.
            var arrowBody GStatement? = TryFoldComputedPropertyArrow(
                node.ExpressionBody,
                accessors,
                allowRefReturn: isRefReturnProperty
            )
            if arrowBody != nil {
                accessors = List[PropertyAccessor]()
            }
            let isOverride = symbol != nil && symbol.IsOverride
            // An override get-only auto-property with an initializer
            // (`public override T P { get; } = init;`) cannot surface as
            // `get; init;` — the base declares only a getter, so the init
            // accessor has no override target and the property stops
            // implementing the abstract getter. Lower it to the synthesized
            // private backing field (seeded with the initializer above) plus a
            // computed arrow reading it.
            if (
                lowersToBackingField ||
                    (
                    isOverride &&
                        !isStatic &&
                        node.Initializer != nil &&
                        symbol?.SetMethod == nil &&
                        IsGetOnlyAutoProperty(node)
                )
            ) &&
                fieldKeywordBackingName != nil {
                arrowBody = ReturnStatement(IdentifierExpression(fieldKeywordBackingName))
                accessors = List[PropertyAccessor]()
            }
            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            let isAbstract = symbol?.IsAbstract == true && symbol!!.ContainingType.TypeKind != TypeKind.Interface
            let isOpen = !isAbstract && this.IsMemberEmittedOpen(symbol, isOverride)
            // Issue #2362, ADR-0149: see the matching visibility comment in
            // TranslateMethod for the full rationale — a G# user-interface
            // explicit property implementation (explicit-interface clause + CLR
            // MethodImpl) keeps C#'s own `private`-equivalent visibility
            // (Roslyn reports `Private`, mapped straight through by
            // MapVisibility).
            let explicitInterfacePropertyVisibility = if isExplicitInterfacePropertyImpl &&
                !usesExplicitInterfacePropertyClause {
                Visibility.Default
            } else {
                MapVisibility(symbol, this.context, node)
            }
            let property = PropertyDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                type,
                accessors: accessors,
                visibility: explicitInterfacePropertyVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: attributes,
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfacePropertyType,
                isRefReturn: isRefReturnProperty,
                isReadOnlyRefReturn: symbol?.ReturnsByRefReadonly == true,
                isAbstract: isAbstract
            )
            return (property, isStatic, backingField)
        }

        // Issue #1907: a property using the C#14 `field` keyword in any accessor
        // shares ONE compiler-synthesized backing field across all its accessors.
        // Detects that usage and synthesizes+registers a real G# field name for it
        // (collision-checked against the containing type's other members, any
        // backing field already synthesized for a sibling property, and any
        // cs2gs-synthesized primary-constructor-parameter field — issue #2003;
        // none of the latter are Roslyn source symbols, so `GetMembers()` alone
        // cannot see them), returning null when the property does not use `field`
        // at all. Also returns the synthesized field's own Roslyn IFieldSymbol
        // (needed for its independent nullable-usage promotion) via
        // <paramref name="fieldSymbol"/>.
        private func TryRegisterFieldKeywordBackingField(
            node PropertyDeclarationSyntax,
            symbol IPropertySymbol?,
            primaryCtorParamNames IReadOnlyCollection[string]?,
            out fieldSymbol IFieldSymbol?
        ) string? {
            fieldSymbol = nil
            if symbol == nil {
                return nil
            }
            fieldSymbol = node
                .DescendantNodes()
                .OfType[FieldExpressionSyntax]()
                .Select(
                (fieldExpr FieldExpressionSyntax) -> this.context.GetSymbolInfo(fieldExpr).Symbol as IFieldSymbol
            )
                .FirstOrDefault(
                (backingSymbol IFieldSymbol) -> backingSymbol != nil && SymbolEqualityComparer.Default.Equals(
                    backingSymbol.AssociatedSymbol,
                    symbol
                )
            )
            if fieldSymbol == nil {
                return nil
            }
            return this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames)
        }

        private func RegisterSynthesizedPropertyBackingField(
            symbol IPropertySymbol?,
            primaryCtorParamNames IReadOnlyCollection[string]?
        ) string {
            if this.state.SynthesizedPropertyBackingFieldNames.TryGetValue(symbol!!, out var existing) {
                return existing
            }
            let propName = symbol!!.Name
            let baseName = "_" +
                (
                if propName.Length > 0 {
                    char.ToLowerInvariant(propName[0]) + propName.Substring(1)
                } else {
                    propName
                }
            )
            let taken = HashSet[string](
                symbol!!.ContainingType.GetMembers().Select((member ISymbol) -> member.Name),
                StringComparer.Ordinal
            )
            if primaryCtorParamNames != nil {
                taken.UnionWith(primaryCtorParamNames)
            } else {
                // Issue #4350 (review): a caller without the aggregate's
                // primary-constructor name set (a write site reached first)
                // conservatively reserves every instance-constructor parameter
                // name, since a lifted primary constructor's synthesized fields
                // are named after exactly those parameters.
                taken.UnionWith(
                    symbol!!
                        .ContainingType
                        .InstanceConstructors
                        .SelectMany(
                        func (constructor IMethodSymbol) IEnumerable[IParameterSymbol] {
                            return constructor.Parameters
                        }
                    )
                        .Select((parameter IParameterSymbol) -> parameter.Name)
                )
            }
            taken.UnionWith(this.state.SynthesizedPropertyBackingFieldNames.Values)
            taken.UnionWith(this.state.LiftedStaticLocalFunctions.Values)
            taken.UnionWith(
                this
                    .state
                    .LiftedRecursiveLocalFunctions
                    .Values
                    .Select((lift LiftedRecursiveLocalFunction) -> lift.Name!!)
            )
            taken.UnionWith(
                this
                    .state
                    .PendingStaticSynthHelpers
                    ?.Select((helper MethodDeclaration) -> helper.Name) ??
                    Enumerable.Empty[string]()
            )
            taken.UnionWith(
                this
                    .state
                    .PendingInstanceSynthHelpers
                    ?.Select((helper MethodDeclaration) -> helper.Name) ??
                    Enumerable.Empty[string]()
            )
            let candidate = LiftedLocalFunctionNameAllocator.For(this.context.Compilation).AllocateBackingField(
                symbol,
                taken,
                baseName
            )
            this.state.SynthesizedPropertyBackingFieldNames[symbol!!] = candidate
            return candidate
        }

        private func MapAccessors(node PropertyDeclarationSyntax, fieldKeywordBackingName string? = nil) List[
            PropertyAccessor
        ] {
            return this.MapAccessors(node, "property '${node.Identifier.Text}'", fieldKeywordBackingName)
        }

        shared {
            private func IsSignedIntegerSpecialType(type SpecialType) bool -> type == SpecialType.System_SByte ||
                type == SpecialType.System_Int16 ||
                type == SpecialType.System_Int32 ||
                type == SpecialType.System_Int64

            private func IsUnsignedIntegerSpecialType(type SpecialType) bool -> type == SpecialType.System_Byte ||
                type == SpecialType.System_UInt16 ||
                type == SpecialType.System_UInt32 ||
                type == SpecialType.System_UInt64

            // Both parts are built from the implementation's symbol, so its
            // documentation-comment id (containing type + name + parameter types)
            // identifies the pair across every unit of the compilation.
            private func PartialPairKeyOf(
                implementation IMethodSymbol?
            ) string -> implementation!!.GetDocumentationCommentId() ?? implementation!!.ToDisplayString()

            private func HasParameterAttributes(parameter IParameterSymbol) bool -> (
                parameter
                    .DeclaringSyntaxReferences
                    .FirstOrDefault()
                    ?.GetSyntax() is ParameterSyntax and
                    {AttributeLists: {Count: > 0}}
            )

            private func CanDeclarePartialFunction(
                ownerKind TypeDeclarationKind
            ) bool -> ownerKind == TypeDeclarationKind.Class ||
                ownerKind == TypeDeclarationKind.Struct ||
                ownerKind == TypeDeclarationKind.DataClass ||
                ownerKind == TypeDeclarationKind.DataStruct

            private func CompilationReferencesAssembly(
                compilation CSharpCompilation?,
                assembly IAssemblySymbol?
            ) bool -> compilation != nil &&
                assembly != nil &&
                compilation
                .References
                .Any(
                (reference MetadataReference) -> compilation.GetAssemblyOrModuleSymbol(
                    reference
                ) is IAssemblySymbol referenced &&
                    SameAssembly(referenced, assembly)
            )

            private func SameAssembly(left IAssemblySymbol?, right IAssemblySymbol?) bool -> left != nil &&
                right != nil &&
                string.Equals(left.Identity.GetDisplayName(), right.Identity.GetDisplayName(), StringComparison.Ordinal)

            private func FindNamespace(root INamespaceSymbol, namespaceName string) INamespaceSymbol? {
                var current INamespaceSymbol? = root
                for segment in namespaceName.Split('.', StringSplitOptions.RemoveEmptyEntries) {
                    current = current?.GetNamespaceMembers().FirstOrDefault(
                        (candidate INamespaceSymbol) -> candidate.Name == segment
                    )
                    if current == nil {
                        return nil
                    }
                }
                return current
            }

            private func ExtensionMethodIdentity(method IMethodSymbol?) string {
                let original IMethodSymbol? = method?.ReducedFrom ?? method
                let declarationId = DocumentationCommentId.CreateDeclarationId(original!!) ??
                    original!!.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)
                return original!!.ContainingAssembly?.Identity.GetDisplayName() + "|" + declarationId
            }

            /// Issue #1911: finds the sibling method on the same containing type that
            /// would win the (name, signature) slot over [`explicitImplementation`](paramref)
            /// once both are translated to G# — i.e. the sibling that this declaration
            /// must yield to so the pair does not become an exact GS0264
            /// duplicate-overload. Returns `null` when
            /// [`explicitImplementation`](paramref) is itself the survivor (no
            /// same-signature sibling, or it is the earliest-declared one among a set
            /// of same-signature explicit implementations). Only invoked for an
            /// EXTERNAL (BCL/imported) interface explicit implementation — a G#
            /// user-interface explicit implementation (issue #2010/#2362, ADR-0149)
            /// carries its own explicit-interface qualifier clause and never
            /// collides on name in the first place.
            /// @remarks A plain public method always wins over any explicit implementation
            /// (it is the pre-existing, name-visible API). Among two or more explicit
            /// implementations with no public sibling (e.g. two interfaces whose
            /// abstract member happens to share a name and signature — a same-name
            /// diamond), the earliest-declared one (by source position) wins; the
            /// rest are dropped. Because a single G# method satisfies every
            /// implemented interface whose abstract member matches its name and
            /// signature, the survivor alone still fills every interface slot the
            /// dropped siblings would have filled — but if the dropped siblings had
            /// DISTINCT bodies (as valid C# allows for genuinely separate explicit
            /// implementations), this collapses divergent runtime behavior into a
            /// single body, which IS a semantic loss. Every such drop is reported
            /// via an Unsupported diagnostic (see the reporting call site).
            private func FindPriorCollidingSibling(
                explicitImplementation IMethodSymbol?,
                node MethodDeclarationSyntax
            ) IMethodSymbol? {
                let containingType INamedTypeSymbol? = explicitImplementation!!.ContainingType
                if containingType == nil {
                    return nil
                }
                // Issue #1911: an explicit interface implementation's own `.Name` is
                // the fully-qualified C# emit name (e.g. "IGreeter.Greet", or
                // "Corpus.Grid06.IGreeter.Greet" for a generic/qualified interface),
                // so `INamedTypeSymbol.GetMembers(name)` — an exact `.Name` lookup —
                // finds neither a same-named public method nor another explicit
                // implementation by the interface member's simple name ("Greet").
                // Every member is walked instead, comparing each candidate's
                // *effective* simple name (its own `.Name` for a plain method, or its
                // interface member's simple name for an explicit implementation).
                let simpleName = explicitImplementation!!.ExplicitInterfaceImplementations[0].Name
                let selfPosition = node.Identifier.SpanStart
                var bestPublicCandidate IMethodSymbol? = nil
                var bestExplicitCandidate IMethodSymbol? = nil
                var bestExplicitPosition = int32.MaxValue
                for member in containingType.GetMembers() {
                    if member is not IMethodSymbol candidate || SymbolEqualityComparer.Default.Equals(
                        candidate,
                        explicitImplementation
                    ) ||
                        EffectiveSimpleName(candidate) != simpleName ||
                        candidate
                        .Parameters
                        .Length != explicitImplementation!!
                        .Parameters
                        .Length ||
                        candidate
                        .TypeParameters
                        .Length != explicitImplementation!!
                        .TypeParameters
                        .Length ||
                        !SymbolEqualityComparer
                        .Default
                        .Equals(candidate.ReturnType, explicitImplementation!!.ReturnType) ||
                        !HasSameParameterTypes(candidate, explicitImplementation) {
                        continue
                    }
                    if candidate.ExplicitInterfaceImplementations.Length == 0 {
                        bestPublicCandidate = candidate
                        continue
                    }
                    let candidatePosition = candidate
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.Span
                        .Start ??
                        int32.MaxValue
                    if candidatePosition < bestExplicitPosition {
                        bestExplicitCandidate = candidate
                        bestExplicitPosition = candidatePosition
                    }
                }
                // A plain public method always wins over an explicit implementation.
                if bestPublicCandidate != nil {
                    return bestPublicCandidate
                }
                // Among explicit implementations only, the earliest-declared one
                // wins; this declaration yields only if some other explicit impl is
                // strictly earlier.
                if bestExplicitCandidate != nil && bestExplicitPosition < selfPosition {
                    return bestExplicitCandidate
                }
                return nil
            }

            private func EffectiveSimpleName(method IMethodSymbol) string {
                return if method.ExplicitInterfaceImplementations.Length > 0 {
                    method.ExplicitInterfaceImplementations[0].Name
                } else {
                    method.Name
                }
            }

            private func HasSameParameterTypes(left IMethodSymbol, right IMethodSymbol?) bool {
                for var i = 0; i < left.Parameters.Length; i++ {
                    if !SymbolEqualityComparer.Default.Equals(left.Parameters[i].Type, right!!.Parameters[i].Type) {
                        return false
                    }
                }
                return true
            }

            /// Issue #1911: formats a surviving sibling method's name for use in
            /// translation diagnostics — the interface-qualified
            /// `IInterface.Member` form for another explicit implementation, or
            /// the plain member name for an ordinary public method.
            private func FormatSiblingName(sibling IMethodSymbol) string {
                return if sibling.ExplicitInterfaceImplementations.Length > 0 {
                    FormatExplicitInterfaceName(sibling)
                } else {
                    sibling.Name
                }
            }

            /// Issue #1911: formats an explicit interface implementation's C#-style
            /// `IInterface.Member` name for use in translation diagnostics.
            private func FormatExplicitInterfaceName(symbol IMethodSymbol?) string {
                let explicitInterfaceMember ISymbol = symbol!!.ExplicitInterfaceImplementations[0]
                return "${explicitInterfaceMember.ContainingType.Name}.${explicitInterfaceMember.Name}"
            }

            /// Issue #2362: property/indexer counterpart of
            /// (cref:FindPriorCollidingSibling), used for BOTH an external
            /// interface's explicit property implementation (collision-drop
            /// fallback, exactly like the method case) AND an indexer's explicit
            /// implementation of ANY interface, user or external (indexers have no
            /// distinct-name mangling available at all — see the call site in
            /// (cref:TranslateIndexer) — so every indexer explicit impl uses
            /// this collision-drop path, never the mangled-name one).
            ///
            /// Unlike the method version, a return/property-TYPE mismatch does
            /// NOT exempt two candidates from colliding: G# properties have no
            /// covariant-return "bridge" mechanism (issue #985 has no property
            /// analogue), so two same-effective-name, same-parameter-shape
            /// properties always occupy the same flat-namespace slot in G#
            /// regardless of their declared type.
            private func FindPriorCollidingSiblingProperty(
                explicitImplementation IPropertySymbol?,
                node BasePropertyDeclarationSyntax
            ) IPropertySymbol? {
                let containingType INamedTypeSymbol? = explicitImplementation!!.ContainingType
                if containingType == nil {
                    return nil
                }
                let simpleName = explicitImplementation!!.ExplicitInterfaceImplementations[0].Name
                let selfPosition = node.SpanStart
                var bestPublicCandidate IPropertySymbol? = nil
                var bestExplicitCandidate IPropertySymbol? = nil
                var bestExplicitPosition = int32.MaxValue
                for member in containingType.GetMembers() {
                    if member is not IPropertySymbol candidate || SymbolEqualityComparer.Default.Equals(
                        candidate,
                        explicitImplementation
                    ) ||
                        EffectiveSimplePropertyName(candidate) != simpleName ||
                        candidate
                        .Parameters
                        .Length != explicitImplementation!!
                        .Parameters
                        .Length ||
                        !HasSamePropertyParameterTypes(candidate, explicitImplementation) {
                        continue
                    }
                    if candidate.ExplicitInterfaceImplementations.Length == 0 {
                        bestPublicCandidate = candidate
                        continue
                    }
                    let candidatePosition = candidate
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.Span
                        .Start ??
                        int32.MaxValue
                    if candidatePosition < bestExplicitPosition {
                        bestExplicitCandidate = candidate
                        bestExplicitPosition = candidatePosition
                    }
                }
                // A plain public property always wins over an explicit implementation.
                if bestPublicCandidate != nil {
                    return bestPublicCandidate
                }
                // Among explicit implementations only, the earliest-declared one
                // wins; this declaration yields only if some other explicit impl is
                // strictly earlier.
                if bestExplicitCandidate != nil && bestExplicitPosition < selfPosition {
                    return bestExplicitCandidate
                }
                return nil
            }

            private func EffectiveSimplePropertyName(property IPropertySymbol) string {
                return if property.ExplicitInterfaceImplementations.Length > 0 {
                    property.ExplicitInterfaceImplementations[0].Name
                } else {
                    property.Name
                }
            }

            private func HasSamePropertyParameterTypes(left IPropertySymbol, right IPropertySymbol?) bool {
                for var i = 0; i < left.Parameters.Length; i++ {
                    if !SymbolEqualityComparer.Default.Equals(left.Parameters[i].Type, right!!.Parameters[i].Type) {
                        return false
                    }
                }
                return true
            }

            /// Issue #2362: property/indexer counterpart of
            /// (cref:FormatSiblingName).
            private func FormatSiblingPropertyName(sibling IPropertySymbol) string {
                return if sibling.ExplicitInterfaceImplementations.Length > 0 {
                    FormatExplicitInterfacePropertyName(sibling)
                } else {
                    sibling.Name
                }
            }

            /// Issue #2362: property/indexer counterpart of
            /// (cref:FormatExplicitInterfaceName).
            private func FormatExplicitInterfacePropertyName(symbol IPropertySymbol?) string {
                let explicitInterfaceMember ISymbol = symbol!!.ExplicitInterfaceImplementations[0]
                return "${explicitInterfaceMember.ContainingType.Name}.${explicitInterfaceMember.Name}"
            }

            /// ADR-0149 (issue #2362 follow-up): event counterpart of
            /// (cref:FindPriorCollidingSiblingProperty) — an event has no
            /// parameter list to disambiguate overloads by, so the match is purely
            /// on effective simple name (mirrors (cref:FindPriorCollidingSibling)
            /// for methods, minus the arity/type-parameter comparison).
            private func FindPriorCollidingSiblingEvent(
                explicitImplementation IEventSymbol?,
                node EventDeclarationSyntax
            ) IEventSymbol? {
                let containingType INamedTypeSymbol? = explicitImplementation!!.ContainingType
                if containingType == nil {
                    return nil
                }
                let simpleName = explicitImplementation!!.ExplicitInterfaceImplementations[0].Name
                let selfPosition = node.SpanStart
                var bestPublicCandidate IEventSymbol? = nil
                var bestExplicitCandidate IEventSymbol? = nil
                var bestExplicitPosition = int32.MaxValue
                for member in containingType.GetMembers() {
                    if member is not IEventSymbol candidate || SymbolEqualityComparer.Default.Equals(
                        candidate,
                        explicitImplementation
                    ) ||
                        EffectiveSimpleEventName(candidate) != simpleName {
                        continue
                    }
                    if candidate.ExplicitInterfaceImplementations.Length == 0 {
                        bestPublicCandidate = candidate
                        continue
                    }
                    let candidatePosition = candidate
                        .DeclaringSyntaxReferences
                        .FirstOrDefault()
                        ?.Span
                        .Start ??
                        int32.MaxValue
                    if candidatePosition < bestExplicitPosition {
                        bestExplicitCandidate = candidate
                        bestExplicitPosition = candidatePosition
                    }
                }
                // A plain public event always wins over an explicit implementation.
                if bestPublicCandidate != nil {
                    return bestPublicCandidate
                }
                // Among explicit implementations only, the earliest-declared one
                // wins; this declaration yields only if some other explicit impl is
                // strictly earlier.
                if bestExplicitCandidate != nil && bestExplicitPosition < selfPosition {
                    return bestExplicitCandidate
                }
                return nil
            }

            private func EffectiveSimpleEventName(ev IEventSymbol) string {
                return if ev.ExplicitInterfaceImplementations.Length > 0 {
                    ev.ExplicitInterfaceImplementations[0].Name
                } else {
                    ev.Name
                }
            }

            /// ADR-0149 (issue #2362 follow-up): event counterpart of
            /// (cref:FormatSiblingPropertyName).
            private func FormatSiblingEventName(sibling IEventSymbol) string {
                return if sibling.ExplicitInterfaceImplementations.Length > 0 {
                    FormatExplicitInterfaceEventName(sibling)
                } else {
                    sibling.Name
                }
            }

            /// ADR-0149 (issue #2362 follow-up): event counterpart of
            /// (cref:FormatExplicitInterfacePropertyName).
            private func FormatExplicitInterfaceEventName(symbol IEventSymbol?) string {
                let explicitInterfaceMember ISymbol = symbol!!.ExplicitInterfaceImplementations[0]
                return "${explicitInterfaceMember.ContainingType.Name}.${explicitInterfaceMember.Name}"
            }

            /// Whether [`kind`](paramref) is a C# 14 instance compound-assignment
            /// operator token (`op_AdditionAssignment` and siblings).
            private func IsCompoundAssignmentOperatorToken(
                kind SyntaxKind
            ) bool -> kind == SyntaxKind.PlusEqualsToken ||
                kind == SyntaxKind.MinusEqualsToken ||
                kind == SyntaxKind.AsteriskEqualsToken ||
                kind == SyntaxKind.SlashEqualsToken ||
                kind == SyntaxKind.PercentEqualsToken ||
                kind == SyntaxKind.AmpersandEqualsToken ||
                kind == SyntaxKind.BarEqualsToken ||
                kind == SyntaxKind.CaretEqualsToken ||
                kind == SyntaxKind.LessThanLessThanEqualsToken ||
                kind == SyntaxKind.GreaterThanGreaterThanEqualsToken ||
                kind == SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken

            private func IsExplicitPositionalAutoProperty(
                node PropertyDeclarationSyntax,
                symbol IPropertySymbol?
            ) bool -> symbol != nil &&
                symbol.IsStatic == false &&
                symbol.IsAbstract == false &&
                symbol
                .ContainingType
                .IsRecord == true &&
                GetPrimaryConstructorParameterList(symbol.ContainingType)?.Parameters.Any(
                (parameter ParameterSyntax) -> parameter.Identifier.ValueText == symbol.Name
            ) == true &&
                node
                .AccessorList
                ?.Accessors
                .All(
                (accessor AccessorDeclarationSyntax) -> accessor.Body == nil && accessor.ExpressionBody == nil
            ) == true

            private func GetPrimaryConstructorParameterList(symbol INamedTypeSymbol?) ParameterListSyntax? -> symbol
                ?.DeclaringSyntaxReferences
                .Select((reference SyntaxReference) -> reference.GetSyntax())
                .OfType[TypeDeclarationSyntax]()
                .Select((declaration TypeDeclarationSyntax) -> declaration.ParameterList)
                .FirstOrDefault((parameters ParameterListSyntax) -> parameters != nil)

            // Issue #1278 / ADR-0131: fold a C# expression-bodied property/indexer
            // into a property-level G# arrow `prop Name T -> expr`. Returns the
            // foldable single statement when the C# member used `=> expr` and its
            // translated get accessor is a single inline statement; otherwise null
            // (the caller keeps the get-only block accessor list).
            // Issue #3879: `allowRefReturn` is set by the property and indexer paths,
            // where the G# arrow form IS ref-aware — `prop P ref T -> lvalue`
            // desugars to `{ get { return ref lvalue } }` in gsc's parser, so the
            // fold preserves the aliasing. It stays false for the extension-property
            // path, which lowers to a `func` whose arrow form has no `-> ref lvalue`
            // spelling (the #3839 method rule).
            private func TryFoldComputedPropertyArrow(
                csExpressionBody ArrowExpressionClauseSyntax?,
                accessors List[PropertyAccessor],
                allowRefReturn bool = false
            ) GStatement? {
                if csExpressionBody == nil ||
                    accessors.Count != 1 ||
                    accessors[0].Kind != Cs2Gs
                    .CodeModel
                    .Ast
                    .AccessorKind
                    .Get ||
                    accessors[0].Body == nil {
                    return nil
                }
                return TryFoldArrowBody(accessors[0].Body, allowRefReturn)
            }
        }
    }
}
