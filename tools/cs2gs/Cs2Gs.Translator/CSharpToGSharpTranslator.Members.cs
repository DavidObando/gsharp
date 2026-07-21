// <copyright file="CSharpToGSharpTranslator.Members.cs" company="GSharp">
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
        private IEnumerable<(GMember Member, bool IsStatic)> TranslateMember(
            MemberDeclarationSyntax member,
            TypeDeclarationKind ownerKind,
            ConstructorLift lift,
            IReadOnlyList<(string Name, GExpression Value)> propertyCtorInits,
            IReadOnlyCollection<string> primaryCtorParamNames = null,
            IReadOnlyCollection<ConstructorDeclarationSyntax> callSiteLoweredStructConstructors = null)
        {
            switch (member)
            {
                case FieldDeclarationSyntax field:
                    foreach ((GMember m, bool s) in this.TranslateField(field, lift))
                    {
                        yield return (m, s);
                    }

                    break;

                case MethodDeclarationSyntax method:
                    (GMember methodMember, bool methodIsStatic) = this.TranslateMethod(method, ownerKind);
                    if (methodMember != null)
                    {
                        yield return (methodMember, methodIsStatic);
                    }

                    break;

                case ExtensionBlockDeclarationSyntax extensionBlock:
                    foreach ((GMember m, bool s) in this.TranslateExtensionBlock(extensionBlock, ownerKind))
                    {
                        yield return (m, s);
                    }

                    break;

                case OperatorDeclarationSyntax op:
                    (GMember opMember, bool opIsStatic) = this.TranslateOperator(op);
                    if (opMember != null)
                    {
                        yield return (opMember, opIsStatic);
                    }

                    break;

                case EventFieldDeclarationSyntax eventField:
                    foreach ((GMember m, bool s) in this.TranslateEventField(eventField))
                    {
                        yield return (m, s);
                    }

                    break;

                case EventDeclarationSyntax explicitEvent:
                    yield return this.TranslateExplicitEvent(explicitEvent);
                    break;

                case DelegateDeclarationSyntax nestedDelegate:
                    GMember translatedDelegate = this.TranslateDelegateDeclaration(nestedDelegate);
                    if (translatedDelegate != null)
                    {
                        yield return (translatedDelegate, true);
                    }

                    break;

                case PropertyDeclarationSyntax property:
                    var propertySymbol = this.context.GetDeclaredSymbol(property) as IPropertySymbol;
                    if (propertySymbol != null &&
                        lift.PropertiesAsPrimaryParameters.Contains(propertySymbol))
                    {
                        break;
                    }

                    // Issue #2281: a non-constant-initializer auto-property lifted
                    // to a body field (see PropertiesAsBodyFields) emits as a plain
                    // `let Name Type = initializer` field rather than a primary-
                    // constructor parameter or a G# `prop`.
                    if (propertySymbol != null &&
                        lift.PropertiesAsBodyFields.Contains(propertySymbol))
                    {
                        GExpression bodyFieldInit = lift.BodyFieldInitializers[propertySymbol];
                        GTypeReference bodyFieldType =
                            this.typeMapper.Map(propertySymbol.Type, this.context, property.Identifier.GetLocation());
                        yield return (
                            new FieldDeclaration(
                                BindingKind.Let,
                                SanitizeIdentifier(property.Identifier.Text),
                                bodyFieldType,
                                bodyFieldInit,
                                Visibility.Public),
                            false);
                        break;
                    }

                    // ADR-0143 §D rule 3 (defensive): C# 13 partial properties
                    // have no G# surface, exactly like partial methods. Skip a
                    // partial-property DEFINITION node: an implemented property's
                    // defining part is dropped in favor of its implementation
                    // part (which translates normally), and an unimplemented
                    // partial-property definition is elided outright.
                    if (propertySymbol is { IsPartialDefinition: true })
                    {
                        break;
                    }

                    // Issue #1190: a static auto-property with an inline initializer
                    // maps to a static backing field in the `shared { }` block, since
                    // a static G# `prop` cannot carry an `init` accessor (GS0374) and
                    // there is no instance constructor to receive the initializer.
                    if (this.TryTranslateStaticAutoPropertyField(property, out FieldDeclaration staticField))
                    {
                        yield return (staticField, true);
                        break;
                    }

                    (GMember propMember, bool propIsStatic, GMember fieldKeywordBackingField) =
                        this.TranslateProperty(property, primaryCtorParamNames);
                    if (fieldKeywordBackingField != null)
                    {
                        // Issue #1907: the synthesized backing field for a `field`-
                        // keyword property is emitted alongside (before) the
                        // property itself, mirroring a hand-written computed
                        // property with an explicit backing field (ADR-0051 §2).
                        // Static/instance-ness must match the property's own.
                        yield return (fieldKeywordBackingField, propIsStatic);
                    }

                    yield return (propMember, propIsStatic);
                    break;

                case IndexerDeclarationSyntax indexer:
                    yield return this.TranslateIndexer(indexer);
                    break;

                case ConstructorDeclarationSyntax ctor:
                    if (callSiteLoweredStructConstructors?.Contains(ctor) == true)
                    {
                        break;
                    }

                    // T2: a fully-lifted constructor is dropped entirely; its field
                    // initialization moved to field initializers / primary-ctor
                    // parameters (ADR-0115 §B.3). Assignments whose RHS reads an
                    // instance member cannot become field initializers, so they are
                    // re-emitted here as a synthesized parameterless `init() { ... }`.
                    if (lift.DropConstructor && lift.Constructor == ctor)
                    {
                        if (lift.ResidualInitStatements.Count > 0)
                        {
                            yield return (
                                new ConstructorDeclaration(
                                    new List<Parameter>(),
                                    new BlockStatement(new List<GStatement>(lift.ResidualInitStatements))),
                                false);
                        }

                        break;
                    }

                    GMember built = this.TranslateConstructor(ctor, propertyCtorInits);
                    if (built != null)
                    {
                        yield return (built, ctor.Modifiers.Any(SyntaxKind.StaticKeyword));
                    }

                    break;

                case DestructorDeclarationSyntax destructor:
                    // A C# finalizer `~T()` maps to the G# `deinit { ... }` block
                    // (ADR-0068, reference types only).
                    yield return (
                        new DestructorDeclaration(
                            this.TranslateBody(destructor, $"finalizer on '{destructor.Identifier.Text}'"),
                            this.MapAttributes(destructor.AttributeLists)),
                        false);
                    break;

                case BaseTypeDeclarationSyntax nestedType:
                    GMember nested = this.Visit(nestedType);
                    if (nested != null)
                    {
                        yield return (nested, true);
                    }

                    break;

                case ConversionOperatorDeclarationSyntax conversion:
                    // gsc issue #1017: a C# user-defined conversion operator
                    // (`public static implicit/explicit operator T(U x)`) maps to
                    // the canonical G# `func operator implicit/explicit (x U) T`
                    // in-body member. `implicit`/`explicit` are contextual keywords
                    // right after `operator`; the single C# parameter is the
                    // conversion source and the C# target type becomes the return
                    // type (ADR-0115 §B).
                    yield return this.TranslateConversionOperator(conversion);
                    break;

                default:
                    this.context.ReportUnsupported(
                        member,
                        $"member '{member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.11).");
                    break;
            }
        }

        /// <summary>
        /// Issue #1879: translates a C# 14 <c>extension(T x) { ... }</c> /
        /// <c>extension(T) { ... }</c> block, mapping its members onto the same
        /// canonical target as a classic <c>this T x</c> extension method
        /// (ADR-0115 §B.19). The block itself carries no G# declaration of its
        /// own — it is a pure grouping construct — so every yielded member is one
        /// of its declared instance/static methods or properties:
        /// <list type="bullet">
        /// <item>a <b>static</b> member (method or property) has no receiver and
        /// becomes a plain <c>shared</c> member of the enclosing (necessarily
        /// <c>static</c>) class; its call sites — always qualified through the
        /// *extended type's name* (`string.Repeat(...)`), never the declaring
        /// class — are rewritten in <see cref="TranslateMemberAccess"/>;</item>
        /// <item>an <b>instance</b> method becomes a receiver-clause <c>func</c>
        /// exactly like a classic extension method, reusing
        /// <see cref="TranslateMethod"/> with the block's own parameter supplied
        /// as the forced receiver;</item>
        /// <item>an <b>instance</b> property has no receiver-clause form in the
        /// G# grammar (<c>prop</c> carries no receiver clause) and is instead
        /// lowered to a receiver-clause <c>func</c> named after the property; a
        /// property with a setter has no call-site lowering (an assignment
        /// target), so it is reported as an explicit, loud gap rather than
        /// silently mistranslated.</item>
        /// </list>
        /// </summary>
        private IEnumerable<(GMember Member, bool IsStatic)> TranslateExtensionBlock(
            ExtensionBlockDeclarationSyntax node,
            TypeDeclarationKind ownerKind)
        {
            // Issue #1879: a generic extension block (`extension<T>(IEnumerable<T> src)
            // where T : notnull { ... }`) is a real C# 14 form, but G#'s
            // receiver-clause `func`/`prop` grammar carries no block-level type
            // parameter or constraint clause. Silently dropping `T` would emit a
            // dangling, wrong-generic G# member with no gap raised — a silent
            // miscompile. Full generic-extension lowering (synthesizing a generic
            // owner, threading `T` through every member and call site) is a larger
            // follow-up; gap loudly instead (ADR-0115 §B.19).
            if (node.TypeParameterList != null || node.ConstraintClauses.Count > 0)
            {
                this.context.ReportUnsupported(
                    node,
                    "a generic extension block (`extension<T>(...)`) has no canonical G# mapping yet; G#'s receiver-clause `func`/`prop` grammar carries no block-level type parameter or constraint clause (ADR-0115 §B.19).");
                yield break;
            }

            ParameterSyntax receiverParameter = node.ParameterList.Parameters.Count > 0
                ? node.ParameterList.Parameters[0]
                : null;

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
            if (receiverParameter?.Modifiers.Count > 0)
            {
                string modifierText = string.Join(" ", receiverParameter.Modifiers.Select(m => m.Text));
                this.context.ReportUnsupported(
                    node,
                    $"an extension block receiver parameter modifier ('{modifierText}') has no canonical G# mapping yet; G#'s receiver-clause grammar accepts the same modifier tokens syntactically, but gsc's binder does not honor by-ref/scoped semantics on a receiver-clause parameter, so mapping the modifier through would silently change behavior rather than gap (ADR-0115 §B.19, ADR-0019).");
                yield break;
            }

            // A receiverless block (`extension(string) { ... }`) names only the
            // extended type, with no identifier to bind — it may declare static
            // members only. A named block (`extension(string s) { ... }`) binds
            // `s` as the receiver for its instance members (and may still declare
            // static members that simply ignore it).
            bool hasNamedReceiver = receiverParameter != null && !receiverParameter.Identifier.IsMissing
                && receiverParameter.Identifier.Text.Length > 0;

            Receiver receiver = null;
            if (hasNamedReceiver)
            {
                var receiverSymbol = this.context.GetDeclaredSymbol(receiverParameter) as IParameterSymbol;
                GTypeReference receiverType = receiverSymbol != null
                    ? this.typeMapper.Map(receiverSymbol.Type, this.context, receiverParameter.GetLocation())
                    : this.MapTypeSyntax(receiverParameter.Type);

                // Issue #1879 (parity with the classic extension-method path,
                // ADR-0079/ADR-0115 §B.5): an enum receiver cannot carry a G#
                // receiver clause (GS0103). Rather than silently emit a
                // receiver-clause `func` that gsc would reject, gap it loudly —
                // reworking every instance member and call site to the positional
                // `Owner.Method(receiver, …)` form used for classic enum
                // extensions is a larger, separate follow-up.
                if (receiverSymbol != null && receiverSymbol.Type.TypeKind == TypeKind.Enum)
                {
                    this.context.ReportUnsupported(
                        node,
                        "an extension block with an enum receiver has no canonical G# mapping yet; a receiver clause is rejected on enum types (GS0103) and the positional call-site rewrite classic enum extension methods use (ADR-0115 §B.5) is not yet implemented for extension blocks (ADR-0115 §B.19).");
                    yield break;
                }

                receiver = new Receiver(SanitizeIdentifier(receiverParameter.Identifier.Text), receiverType);
            }

            foreach (MemberDeclarationSyntax member in node.Members)
            {
                switch (member)
                {
                    case MethodDeclarationSyntax method:
                        {
                            var methodSymbol = this.context.GetDeclaredSymbol(method) as IMethodSymbol;
                            bool isStatic = methodSymbol != null && methodSymbol.IsStatic;
                            if (!isStatic && receiver == null)
                            {
                                this.context.ReportUnsupported(
                                    method,
                                    $"instance extension member '{method.Identifier.Text}' has no receiver to bind (its enclosing extension block names no receiver); no canonical G# mapping (ADR-0115 §B.19).");
                                break;
                            }

                            yield return this.TranslateMethod(method, ownerKind, isStatic ? null : receiver);
                        }

                        break;

                    case PropertyDeclarationSyntax property:
                        {
                            var propertySymbol = this.context.GetDeclaredSymbol(property) as IPropertySymbol;
                            bool isStatic = propertySymbol != null && propertySymbol.IsStatic;
                            if (isStatic)
                            {
                                (GMember staticPropMember, bool staticPropIsStatic, GMember staticFieldKeywordBacking) =
                                    this.TranslateProperty(property);
                                if (staticFieldKeywordBacking != null)
                                {
                                    yield return (staticFieldKeywordBacking, staticPropIsStatic);
                                }

                                yield return (staticPropMember, staticPropIsStatic);
                                break;
                            }

                            if (receiver == null)
                            {
                                this.context.ReportUnsupported(
                                    property,
                                    $"instance extension property '{property.Identifier.Text}' has no receiver to bind (its enclosing extension block names no receiver); no canonical G# mapping (ADR-0115 §B.19).");
                                break;
                            }

                            if (propertySymbol?.SetMethod != null)
                            {
                                this.context.ReportUnsupported(
                                    property,
                                    $"instance extension property '{property.Identifier.Text}' has a setter; G#'s `prop` grammar has no receiver clause (only `func` does, ADR-0115 §B.19), so it is lowered to a get-only receiver-clause func — a setter has no call-site lowering (it is an assignment target, not a call) and is reported rather than silently dropped.");
                                break;
                            }

                            yield return this.TranslateExtensionProperty(property, receiver);
                        }

                        break;

                    default:
                        this.context.ReportUnsupported(
                            member,
                            $"extension-block member '{member.Kind()}' has no canonical G# mapping yet (ADR-0115 §B.19).");
                        break;
                }
            }
        }

        /// <summary>
        /// Issue #1879: lowers a C# 14 instance extension property (declared
        /// inside an <c>extension(T x) { ... }</c> block) to a receiver-clause
        /// <c>func</c> named after the property — G#'s <c>prop</c> grammar has no
        /// receiver clause, so this is the only canonical target (ADR-0115
        /// §B.19). Every read call site (<c>word.DoubledLength</c>) is rewritten
        /// to a zero-argument call (<c>word.DoubledLength()</c>) in
        /// <see cref="TranslateMemberAccess"/>. Callers only reach this method for
        /// a get-only property (a setter is reported as an explicit gap first).
        /// </summary>
        private (GMember Member, bool IsStatic) TranslateExtensionProperty(
            PropertyDeclarationSyntax node, Receiver receiver)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<PropertyAccessor> accessors = this.MapAccessors(node);
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            BlockStatement body = arrowBody == null
                ? accessors.FirstOrDefault(a => a.Kind == AccessorKind.Get)?.Body
                : null;

            var method = new MethodDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                new List<Parameter>(),
                returnType,
                body,
                receiver: receiver,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            return (method, false);
        }

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateEventField(
            EventFieldDeclarationSyntax node)
        {
            // `public event EventHandler<T>? X;` → G# `public event X EventHandler[T]`
            // (name-then-type; the nullable annotation is dropped because a
            // field-like event is nil-initialized; ADR-0115 §B).
            foreach (VariableDeclaratorSyntax declarator in node.Declaration.Variables)
            {
                var symbol = this.context.GetDeclaredSymbol(declarator) as IEventSymbol;

                GTypeReference type = symbol != null
                    ? this.typeMapper.MapEventType(
                        symbol.Type.WithNullableAnnotation(NullableAnnotation.NotAnnotated),
                        this.context,
                        declarator.GetLocation())
                    : this.MapTypeSyntax(node.Declaration.Type);

                var declaration = new EventDeclaration(
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    MapVisibility(symbol, this.context, node),
                    this.MapAttributes(node.AttributeLists),
                    isOpen: this.IsMemberEmittedOpen(symbol, symbol?.IsOverride == true),
                    isOverride: symbol?.IsOverride == true);

                yield return (declaration, symbol != null && symbol.IsStatic);
            }
        }

        private (GMember Member, bool IsStatic) TranslateExplicitEvent(EventDeclarationSyntax node)
        {
            // `public event Handler X { add { ... } remove { ... } }` — the explicit
            // accessor form of ADR-0052 §2. No backing field is synthesized; the
            // `add`/`remove` bodies translate like any other accessor body, with
            // `value` bound as the implicit handler parameter (already an ordinary
            // identifier in the C# source, so it round-trips unchanged).
            var symbol = this.context.GetDeclaredSymbol(node) as IEventSymbol;

            // ADR-0149 (issue #2362 follow-up): generalizes the method/property/
            // indexer explicit-interface qualifier clause to events for the first
            // time — a C# explicit event implementation
            // (`event Handler IFoo.Changed { add; remove; }`) maps to
            // `event (IFoo) Changed T` for a G# USER interface, using the same
            // clause + CLR MethodImpl bridge as every other member kind. Only the
            // custom add/remove accessor form (this method) can carry an explicit
            // interface specifier in C# — a field-like event never can — so
            // TranslateEventField needs no matching change. An EXTERNAL/BCL
            // interface explicit event implementation still falls back to the
            // #1911-style forced-public name-based dispatch.
            bool isExplicitInterfaceEventImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            bool isUserInterfaceExplicitEventImpl = isExplicitInterfaceEventImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1 &&
                symbol.ExplicitInterfaceImplementations[0].ContainingType.Locations.Any(l => l.IsInSource);

            if (isExplicitInterfaceEventImpl && symbol.ExplicitInterfaceImplementations.Length > 1 &&
                symbol.ExplicitInterfaceImplementations.All(e => e.ContainingType.Locations.Any(l => l.IsInSource)))
            {
                string names = string.Join(", ", symbol.ExplicitInterfaceImplementations.Select(e => e.ContainingType.Name));
                string multiEntryMessage =
                    $"explicit interface event implementation '{FormatExplicitInterfaceEventName(symbol)}' satisfies " +
                    $"more than one G# user interface member in one C# declaration ({names}), likely via interface " +
                    "inheritance (a base interface re-declaring the same event). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per event, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the event keeps its plain name " +
                    "and every interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: " +
                    "the event becomes publicly subscribable by name, unlike real C# explicit-impl semantics).";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.EventDeclaration), multiEntryMessage, node.GetLocation(), TranslationSeverity.Info));
            }

            if (isExplicitInterfaceEventImpl && !isUserInterfaceExplicitEventImpl)
            {
                IEventSymbol eventSurvivor = FindPriorCollidingSiblingEvent(symbol, node);
                if (eventSurvivor != null)
                {
                    string message =
                        $"explicit interface event implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfaceEventName(symbol)}' " +
                        $"shares its name with '{symbol.ContainingType.Name}.{FormatSiblingEventName(eventSurvivor)}'; " +
                        "G# has no explicit-interface-implementation surface for EXTERNAL interfaces (ADR-0091), so the " +
                        "two C# events cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "subscription through the interface-typed reference that previously reached this event now " +
                        "silently observes the surviving event instead (semantic loss, known gap, issue #1911 " +
                        "analogue). This diagnostic covers only EXTERNAL/BCL interfaces — a same-signature collision " +
                        "between two G# user-interface explicit event implementations is fully supported (issue " +
                        "#2362 follow-up, ADR-0149 explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.EventDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type for
            // a G# user-interface explicit event implementation, or null
            // otherwise (ordinary event, or external-interface explicit
            // implementation, which keeps the pre-#2010 name-based dispatch).
            GTypeReference explicitInterfaceEventType = isUserInterfaceExplicitEventImpl
                ? this.typeMapper.Map(symbol.ExplicitInterfaceImplementations[0].ContainingType, this.context, node.GetLocation())
                : null;

            GTypeReference type = symbol != null
                ? this.typeMapper.MapEventType(
                    symbol.Type.WithNullableAnnotation(NullableAnnotation.NotAnnotated),
                    this.context,
                    node.GetLocation())
                : this.MapTypeSyntax(node.Type);

            AccessorDeclarationSyntax addAccessor = node.AccessorList?.Accessors
                .FirstOrDefault(a => a.IsKind(SyntaxKind.AddAccessorDeclaration));
            AccessorDeclarationSyntax removeAccessor = node.AccessorList?.Accessors
                .FirstOrDefault(a => a.IsKind(SyntaxKind.RemoveAccessorDeclaration));

            BlockStatement addBody = addAccessor != null
                ? this.TranslateBody(addAccessor, $"'add' accessor of event '{node.Identifier.Text}'")
                : new BlockStatement(new List<GStatement>());
            BlockStatement removeBody = removeAccessor != null
                ? this.TranslateBody(removeAccessor, $"'remove' accessor of event '{node.Identifier.Text}'")
                : new BlockStatement(new List<GStatement>());

            // ADR-0149: see the matching visibility comment in
            // TranslatePropertyDeclaration for the full rationale — a G#
            // user-interface explicit event implementation (explicit-interface
            // clause + CLR MethodImpl) keeps C#'s own `private`-equivalent
            // visibility; an EXTERNAL/BCL interface explicit event
            // implementation still relies on name-based dispatch and must stay
            // forced-public (`Visibility.Default`) or ilverify would reject the
            // missing interface method.
            Visibility eventVisibility = isExplicitInterfaceEventImpl && !isUserInterfaceExplicitEventImpl
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var declaration = new EventDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                type,
                eventVisibility,
                this.MapAttributes(node.AttributeLists),
                addBody,
                removeBody,
                explicitInterfaceType: explicitInterfaceEventType,
                isOpen: this.IsMemberEmittedOpen(symbol, symbol?.IsOverride == true),
                isOverride: symbol?.IsOverride == true);

            return (declaration, symbol != null && symbol.IsStatic);
        }

        private GMember TranslateDelegateDeclaration(DelegateDeclarationSyntax node)
        {
            // `public delegate R Name(params);` → G# named delegate type alias
            // `type Name = delegate func(params) R` (ADR-0059). Generic delegates
            // (issue #1960) carry their type parameters into the bracket section,
            // `type Name[T] = delegate func(params) R` — gsc's binder/emitter
            // support this (ADR-0059 "Follow-up work", issue #1503; GS0234 retired).
            var symbol = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol;
            IMethodSymbol invoke = symbol?.DelegateInvokeMethod;

            List<Parameter> parameters = this.MapParameterList(node.ParameterList);
            GTypeReference returnType = invoke != null
                ? this.MapDelegateLikeReturnType(invoke, isAsync: false, node.ReturnType.GetLocation())
                : this.MapTypeSyntax(node.ReturnType);
            List<TypeParameter> typeParameters = this.MapTypeParameters(symbol);

            return new NamedDelegateDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                parameters,
                returnType,
                MapVisibility(symbol, this.context, node),
                this.MapAttributes(node.AttributeLists),
                typeParameters);
        }

        /// <summary>
        /// Wraps a translated constant expression in an explicit G# cast when the
        /// C# semantic model implicitly converts a signed-integer constant to an
        /// unsigned-integer target (<c>uint x = 0</c>, <c>const byte b = 31</c>).
        /// G# requires the conversion to be explicit (OD-T2, otherwise GS0156
        /// "Cannot convert int32 to uintN").
        /// </summary>
        private GExpression CoerceConstantToUnsigned(ExpressionSyntax expression, GExpression translated)
        {
            TypeInfo info = this.context.GetTypeInfo(expression);
            ITypeSymbol source = info.Type;
            ITypeSymbol target = info.ConvertedType;
            if (source != null &&
                target != null &&
                !SymbolEqualityComparer.Default.Equals(source, target) &&
                IsSignedIntegerSpecialType(source.SpecialType) &&
                IsUnsignedIntegerSpecialType(target.SpecialType))
            {
                GTypeReference targetRef = this.typeMapper.Map(target, this.context, expression.GetLocation());
                return new ConversionExpression(targetRef, translated);
            }

            return translated;
        }

        private static bool IsSignedIntegerSpecialType(SpecialType type) =>
            type is SpecialType.System_SByte or SpecialType.System_Int16
                or SpecialType.System_Int32 or SpecialType.System_Int64;

        private static bool IsUnsignedIntegerSpecialType(SpecialType type) =>
            type is SpecialType.System_Byte or SpecialType.System_UInt16
                or SpecialType.System_UInt32 or SpecialType.System_UInt64;

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateField(
            FieldDeclarationSyntax field,
            ConstructorLift lift)
        {
            foreach (VariableDeclaratorSyntax declarator in field.Declaration.Variables)
            {
                var symbol = this.context.GetDeclaredSymbol(declarator) as IFieldSymbol;

                // T2: a field that became a primary-constructor parameter is no
                // longer a standalone member (the parameter declares the field).
                if (lift.FieldsAsPrimaryParameters.Contains(declarator.Identifier.Text))
                {
                    continue;
                }

                BindingKind binding = symbol switch
                {
                    { IsConst: true } => BindingKind.Const,
                    { IsReadOnly: true } => BindingKind.Let,
                    _ => BindingKind.Var,
                };

                GTypeReference type = symbol != null
                    ? this.typeMapper.Map(symbol.Type, this.context, declarator.GetLocation())
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

                // Generator-produced fields declared under nullable-oblivious
                // context (Avalonia x:Name fields are the common case) retain
                // C#'s ability to hold/test null when translated as a standalone
                // generated partial part.
                if (this.preservePartialParts &&
                    symbol?.Type is { IsReferenceType: true, NullableAnnotation: NullableAnnotation.None })
                {
                    type = MakeNullable(type);
                }

                // Issue #1072: a non-nullable reference/array field that is
                // null-checked or null-assigned anywhere in the declaring type is
                // really nullable; render it `T?` so the `== nil` guard type-checks.
                if (symbol != null)
                {
                    type = this.PromoteIfUsedAsNullable(type, symbol);
                }

                // T2: a field initializer (ADR-0115 §B.3) comes either from a
                // constructor assignment independent of the constructor parameters
                // (lifted out of the dropped `init`) or from a C# field initializer.
                GExpression initializer = null;
                if (lift.FieldInitializers.TryGetValue(declarator.Identifier.Text, out GExpression lifted))
                {
                    initializer = lifted;
                }
                else if (symbol != null &&
                    this.state.StaticFieldInitializers.TryGetValue(symbol, out GExpression staticLifted))
                {
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
                    if (declarator.Initializer != null &&
                        this.ContainsPotentialSideEffect(declarator.Initializer.Value))
                    {
                        string message =
                            $"field '{declarator.Identifier.Text}' has a side-effecting inline " +
                            "initializer that a static constructor overwrites; folding would " +
                            "silently drop the initializer's side effect (ADR-0115 §B.11).";
                        this.context.ReportUnsupported(declarator, message);
                        continue;
                    }

                    initializer = staticLifted;
                }
                else if (declarator.Initializer != null)
                {
                    initializer = this.CoerceConstantToUnsigned(
                        declarator.Initializer.Value,
                        this.TranslateNullSeamExpression(declarator.Initializer.Value, symbol?.ContainingType));
                    initializer = this.ForgiveNullableReferenceValue(
                        declarator.Initializer.Value,
                        initializer,
                        symbol?.Type,
                        symbol);

                    // Issue #1072: a non-nullable reference field whose initializer
                    // is nullable (e.g. `?.`-access) is rendered `T?`.
                    if (symbol != null)
                    {
                        type = this.PromoteIfInitializerNullable(type, symbol, declarator.Initializer.Value);
                    }
                }

                var declaration = new FieldDeclaration(
                    binding,
                    SanitizeIdentifier(declarator.Identifier.Text),
                    type,
                    initializer: initializer,
                    visibility: MapVisibility(symbol, this.context, field),
                    attributes: this.MapAttributes(field.AttributeLists));

                yield return (declaration, symbol != null && symbol.IsStatic);
            }
        }

        private (GMember Member, bool IsStatic) TranslateMethod(
            MethodDeclarationSyntax node,
            TypeDeclarationKind ownerKind,
            Receiver forcedReceiver = null)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            // ADR-0143 §D: G# has no partial methods, so a C# `partial`
            // method-DEFINITION node never yields a G# member.
            //
            //   * Unimplemented partial method (`IsPartialDefinition` with a
            //     null `PartialImplementationPart`): the whole method is elided
            //     — no member here, and its call sites are dropped by the
            //     statement visitor (see IsElidedPartialMethodInvocation).
            //   * Implemented partial method (a defining + implementing pair):
            //     only the implementation part translates. The defining part
            //     (`IsPartialDefinition` with a non-null
            //     `PartialImplementationPart`) is skipped here; the
            //     implementation part (`IsPartialDefinition == false`,
            //     `PartialDefinitionPart != null`) falls through and translates
            //     normally, so the member is emitted exactly once.
            //
            // This holds in BOTH translation modes and correctly handles the
            // issue #1910 partial-TYPE merge, whose merged member list may
            // contain both the defining and implementing method nodes: the
            // defining node is filtered out by this single guard.
            if (symbol != null && symbol.IsPartialDefinition)
            {
                return (null, false);
            }

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
            // When the implemented interface is an EXTERNAL (BCL/imported) CLR
            // interface, this new mechanism does not apply — the existing #985
            // covariant-return-bridge machinery in gsc's binder already handles
            // that shape (e.g. `IEnumerator IEnumerable.GetEnumerator()`
            // alongside `IEnumerator<T> GetEnumerator()`), and it keys on the
            // method keeping its ORIGINAL (un-mangled) simple name plus a
            // return-type-only signature difference from its public sibling.
            // Adding a clause would not help there (no G# `interface` exists for
            // an external CLR interface to name in G# source), so the #1911
            // "force public, drop on exact-signature collision" handling is
            // preserved unchanged for external interfaces.
            bool isExplicitInterfaceImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            // Issue #2010 follow-up: Roslyn's ExplicitInterfaceImplementations
            // can hold MORE THAN ONE entry — this happens when the explicit
            // member also satisfies an inherited/re-declared same-signature
            // member on a BASE interface (e.g. `void IBar.M(){}` where
            // `interface IBar : IFoo` and IFoo already declares `M`). The
            // clause-based scheme below wires exactly ONE interface slot per
            // method, so it only applies when there is a SINGLE entry and it
            // is a G# user interface. Any other shape (mixed user+external, or
            // >1 user entries) falls back to the pre-#2010 (#1911) named/forced-
            // public path: the method keeps its plain name with no clause, and
            // gsc's ordinary implicit name+signature interface-dispatch matching
            // then satisfies every entry uniformly (no explicit MethodImpl row
            // needed) — lossier (loses C#'s "not publicly callable by name"
            // semantics) but correct, and consistent with the existing
            // external-interface handling.
            bool isUserInterfaceExplicitImpl = isExplicitInterfaceImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1 &&
                symbol.ExplicitInterfaceImplementations[0].ContainingType.Locations.Any(l => l.IsInSource);

            if (isExplicitInterfaceImpl && symbol.ExplicitInterfaceImplementations.Length > 1 &&
                symbol.ExplicitInterfaceImplementations.All(e => e.ContainingType.Locations.Any(l => l.IsInSource)))
            {
                string names = string.Join(", ", symbol.ExplicitInterfaceImplementations.Select(e => e.ContainingType.Name));
                string multiEntryMessage =
                    $"explicit interface implementation '{FormatExplicitInterfaceName(symbol)}' satisfies more than one " +
                    $"G# user interface member in one C# declaration ({names}), likely via interface inheritance " +
                    "(a base interface re-declaring the same signature). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per method, so this falls back to the #1911 " +
                    "named/forced-public path instead of a clause — the method keeps its plain name and every " +
                    "interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: the " +
                    "method becomes publicly callable by name, unlike real C# explicit-impl semantics).";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.MethodDeclaration), multiEntryMessage, node.GetLocation(), TranslationSeverity.Info));
            }

            if (isExplicitInterfaceImpl && !isUserInterfaceExplicitImpl)
            {
                IMethodSymbol survivor = FindPriorCollidingSibling(symbol, node);
                if (survivor != null)
                {
                    string message =
                        $"explicit interface implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfaceName(symbol)}' " +
                        $"shares its name and signature with '{symbol.ContainingType.Name}.{FormatSiblingName(survivor)}'; " +
                        "G# has no explicit-interface-implementation surface for EXTERNAL interfaces (ADR-0091), so the " +
                        "two C# methods cannot both be emitted (would be an exact-signature duplicate, GS0264). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's body differs from this dropped declaration's body, any C# " +
                        "call through the interface-typed reference that previously reached this body now silently " +
                        "observes the surviving method's body instead (semantic loss, known gap, issue #1911). This " +
                        "diagnostic covers only EXTERNAL/BCL interfaces — a same-signature collision between two G# " +
                        "user-interface explicit implementations is fully supported (issue #2010/#2362, ADR-0149 " +
                        "explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.MethodDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a G# user-interface explicit implementation, or null for an
            // ordinary method / an external-interface explicit implementation
            // (which keeps the pre-#2010 name-based dispatch, no clause).
            GTypeReference explicitInterfaceType = isUserInterfaceExplicitImpl
                ? this.typeMapper.Map(symbol.ExplicitInterfaceImplementations[0].ContainingType, this.context, node.GetLocation())
                : null;

            Receiver receiver = null;
            bool skipFirstParameter = false;
            bool selfQualifyBody = false;

            if (forcedReceiver != null)
            {
                // Issue #1879: a C# 14 `extension(T x) { ... }` block instance
                // member has no `this` parameter of its own — the receiver lives
                // on the enclosing extension-block declaration — so the caller
                // (TranslateExtensionBlock) resolves it there and threads it
                // through directly, bypassing the `IsExtensionMethod`-based
                // detection below (the block member's own declared symbol is a
                // synthetic marker with `IsExtensionMethod == false`). Maps to the
                // same receiver-clause `func` as a classic `this T x` extension
                // method (ADR-0115 §B.19).
                receiver = forcedReceiver;
                isStatic = false;
            }
            else if (symbol != null && symbol.IsExtensionMethod)
            {
                // C# extension methods translate to the receiver-clause form on a
                // non-owned type (ADR-0115 §B.5). A receiver clause is only valid
                // on a struct/class (ADR-0079); an extension on an enum receiver
                // is rejected by gsc (GS0103 "must be a struct or class"), so it
                // stays a plain static helper and its call sites are rewritten to
                // the positional form `Owner.Method(receiver, …)`.
                IParameterSymbol self = symbol.Parameters.FirstOrDefault();
                if (self != null && self.Type.TypeKind != TypeKind.Enum)
                {
                    // Issue #1072/#1535: an extension receiver that is null-compared
                    // or null-assigned in the body is really nullable (common in
                    // nullable-oblivious sources, e.g. `this object o => o == null`),
                    // so promote it to `T?` exactly as an ordinary parameter would be
                    // — the receiver path bypasses MapParameters, so the promotion
                    // must be applied here too.
                    GTypeReference receiverType = this.typeMapper.Map(self.Type, this.context, node.GetLocation());
                    receiverType = this.PromoteIfUsedAsNullable(receiverType, self);
                    receiver = new Receiver(
                        SanitizeIdentifier(self.Name),
                        receiverType);
                    skipFirstParameter = true;
                    isStatic = false;
                }
            }
            else if (!isStatic && IsValueAggregate(ownerKind))
            {
                // Owned-struct instance method: the parser rejects an in-body
                // 'func' inside a struct body (GS0005) and the binder flags the
                // receiver-clause form with GS0314, so no warning-free spelling
                // exists today. Emit the only form that parses and record the
                // known gap (issue #938, ADR-0115 §B.5).
                receiver = new Receiver(
                    "self",
                    new NamedTypeReference(symbol?.ContainingType?.Name ?? node.Identifier.Text));
                selfQualifyBody = true;
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.MethodDeclaration),
                    $"instance method '{node.Identifier.Text}' on owned struct/data-struct emits the receiver-clause form (the only form that parses); the binder will flag GS0314 — expected, known compiler gap (issue #938, ADR-0115 §B.5).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirstParameter);
            GTypeReference returnType = this.MapReturnType(symbol, node);
            List<TypeParameter> typeParameters = this.MapMethodTypeParameters(symbol);

            bool hasBody = node.Body != null || node.ExpressionBody != null;
            string previousReceiver = this.state.CurrentReceiverName;
            if (selfQualifyBody)
            {
                this.state.CurrentReceiverName = receiver.Name;
            }

            BlockStatement body;
            try
            {
                body = hasBody
                    ? this.TranslateBody(node, $"method '{node.Identifier.Text}'")
                    : null;
            }
            finally
            {
                this.state.CurrentReceiverName = previousReceiver;
            }

            // ADR-0122 / issue #1014: a C# `unsafe` method body is an unsafe
            // context. The G# member-level `unsafe func` modifier does not combine
            // with an accessibility keyword in the grammar, so — unless the whole
            // owning type is already `unsafe` — the body is wrapped in an
            // `unsafe { … }` block, which round-trips with any visibility and gives
            // the same unsafe context.
            if (body != null &&
                node.Modifiers.Any(SyntaxKind.UnsafeKeyword) &&
                !node.Ancestors().OfType<TypeDeclarationSyntax>().Any(t => t.Modifiers.Any(SyntaxKind.UnsafeKeyword)))
            {
                body = new BlockStatement(new GStatement[]
                {
                    new BlockStatement(body.Statements, isUnsafe: true),
                });
            }

            // Issue #2438: a genuine C# `async void` method (an event handler
            // — the only C# shape with no awaitable result at all) has no G#
            // "async void" counterpart: every G# `async func` is
            // Task-observable at its call site, so translating it as an
            // ordinary async G# method would leave its method-group value
            // typed `(args) -> Task`, unable to convert to the `(args) ->
            // void` event-delegate shape it originally subscribed with
            // (GS0155). Rewrite it into a non-async, void-returning wrapper
            // with the SAME name (so `+=`/`-=` subscription/unsubscription
            // keep referring to the same symbol) that fires the untouched
            // original body off as a nested async literal and surfaces any
            // unobserved fault instead of silently discarding it — see
            // BuildAsyncVoidHandlerWrapperBody for the exact shape/rationale.
            bool isAsyncVoidHandler = body != null && IsCSharpAsyncVoidHandler(symbol);
            if (isAsyncVoidHandler)
            {
                string instanceBodyName = null;
                if (!symbol.IsStatic && symbol.ContainingType.TypeKind == TypeKind.Class)
                {
                    instanceBodyName = "__asyncVoid_" + SanitizeIdentifier(symbol.Name);
                    while (symbol.ContainingType.GetMembers(instanceBodyName).Length > 0)
                    {
                        instanceBodyName += "_";
                    }
                }

                body = this.BuildAsyncVoidHandlerWrapperBody(
                    parameters,
                    body,
                    node.GetLocation(),
                    instanceBodyName,
                    typeParameters);
            }

            bool isOverride = symbol != null && symbol.IsOverride;

            // Interface members are implicitly abstract in C#; in canonical G# the
            // members of an `interface` carry no modifier (the `open` keyword is for
            // virtual/abstract members of a class). Suppress `open` for them so the
            // emitted G# round-trips (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // A method lifted to the top-level receiver-clause form (an owned-value
            // aggregate method or an extension method) has no `open`/`override`:
            // those modifiers are only valid on in-body class members, and the
            // parser rejects `override func (...)` (GS0005). Drop them so the
            // emitted G# round-trips (ADR-0115 §B.5/§B.14).
            if (receiver != null)
            {
                isOpen = false;
                isOverride = false;
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
            GStatement arrowBody = !isAsyncVoidHandler && node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            // Issue #2010/#2362, ADR-0149: a G# user-interface explicit
            // implementation now emits its own plain-named method carrying an
            // explicit-interface qualifier clause and is bound to its own CLR
            // interface slot via an explicit MethodImpl row at emit time — it
            // no longer relies on name-based virtual dispatch, so it can keep
            // C#'s own `private`-equivalent visibility (Roslyn reports
            // `DeclaredAccessibility` as `Private`: no accessibility keyword,
            // unreachable through the class type). This matches C# semantics,
            // where an explicit impl is not publicly callable by the type name.
            //
            // Issue #1911: an EXTERNAL (BCL/imported) interface explicit
            // implementation still relies on the pre-existing name-based
            // #985 covariant-return-bridge slot-filling, which requires the
            // method to be public — mapping Roslyn's `Private` straight
            // through would fail `ilverify` ("Class implements interface but
            // not method"), so it is still forced public here.
            Visibility explicitInterfaceVisibility = isExplicitInterfaceImpl && !isUserInterfaceExplicitImpl
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var method = new MethodDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: typeParameters,
                receiver: receiver,
                visibility: explicitInterfaceVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                isAsync: !isAsyncVoidHandler && symbol != null && symbol.IsAsync,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfaceType,
                isRefReturn: symbol != null && symbol.ReturnsByRef);

            return (method, isStatic);
        }

        /// <summary>
        /// Issue #1911: finds the sibling method on the same containing type that
        /// would win the (name, signature) slot over <paramref name="explicitImplementation"/>
        /// once both are translated to G# — i.e. the sibling that this declaration
        /// must yield to so the pair does not become an exact GS0264
        /// duplicate-overload. Returns <see langword="null"/> when
        /// <paramref name="explicitImplementation"/> is itself the survivor (no
        /// same-signature sibling, or it is the earliest-declared one among a set
        /// of same-signature explicit implementations). Only invoked for an
        /// EXTERNAL (BCL/imported) interface explicit implementation — a G#
        /// user-interface explicit implementation (issue #2010/#2362, ADR-0149)
        /// carries its own explicit-interface qualifier clause and never
        /// collides on name in the first place.
        /// </summary>
        /// <remarks>
        /// A plain public method always wins over any explicit implementation
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
        /// </remarks>
        private static IMethodSymbol FindPriorCollidingSibling(IMethodSymbol explicitImplementation, MethodDeclarationSyntax node)
        {
            INamedTypeSymbol containingType = explicitImplementation.ContainingType;
            if (containingType == null)
            {
                return null;
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
            string simpleName = explicitImplementation.ExplicitInterfaceImplementations[0].Name;
            int selfPosition = node.Identifier.SpanStart;

            IMethodSymbol bestPublicCandidate = null;
            IMethodSymbol bestExplicitCandidate = null;
            int bestExplicitPosition = int.MaxValue;

            foreach (ISymbol member in containingType.GetMembers())
            {
                if (member is not IMethodSymbol candidate ||
                    SymbolEqualityComparer.Default.Equals(candidate, explicitImplementation) ||
                    EffectiveSimpleName(candidate) != simpleName ||
                    candidate.Parameters.Length != explicitImplementation.Parameters.Length ||
                    candidate.TypeParameters.Length != explicitImplementation.TypeParameters.Length ||

                    // Issue #1911: gsc's GS0264 overload check keys on parameter
                    // types AND return type — e.g. a `GetEnumerator() IEnumerator`
                    // bridge coexists fine with `GetEnumerator() IEnumerator[T]`
                    // (issue #985's dual-GetEnumerator pattern), so a return-type
                    // mismatch means these two do NOT collide and both survive.
                    !SymbolEqualityComparer.Default.Equals(candidate.ReturnType, explicitImplementation.ReturnType) ||
                    !HasSameParameterTypes(candidate, explicitImplementation))
                {
                    continue;
                }

                if (candidate.ExplicitInterfaceImplementations.Length == 0)
                {
                    bestPublicCandidate = candidate;
                    continue;
                }

                int candidatePosition = candidate.DeclaringSyntaxReferences.FirstOrDefault()?.Span.Start ?? int.MaxValue;
                if (candidatePosition < bestExplicitPosition)
                {
                    bestExplicitCandidate = candidate;
                    bestExplicitPosition = candidatePosition;
                }
            }

            // A plain public method always wins over an explicit implementation.
            if (bestPublicCandidate != null)
            {
                return bestPublicCandidate;
            }

            // Among explicit implementations only, the earliest-declared one
            // wins; this declaration yields only if some other explicit impl is
            // strictly earlier.
            if (bestExplicitCandidate != null && bestExplicitPosition < selfPosition)
            {
                return bestExplicitCandidate;
            }

            return null;
        }

        private static string EffectiveSimpleName(IMethodSymbol method)
        {
            return method.ExplicitInterfaceImplementations.Length > 0
                ? method.ExplicitInterfaceImplementations[0].Name
                : method.Name;
        }

        private static bool HasSameParameterTypes(IMethodSymbol left, IMethodSymbol right)
        {
            for (int i = 0; i < left.Parameters.Length; i++)
            {
                if (!SymbolEqualityComparer.Default.Equals(left.Parameters[i].Type, right.Parameters[i].Type))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// Issue #1911: formats a surviving sibling method's name for use in
        /// translation diagnostics — the interface-qualified
        /// <c>IInterface.Member</c> form for another explicit implementation, or
        /// the plain member name for an ordinary public method.
        /// </summary>
        private static string FormatSiblingName(IMethodSymbol sibling)
        {
            return sibling.ExplicitInterfaceImplementations.Length > 0
                ? FormatExplicitInterfaceName(sibling)
                : sibling.Name;
        }

        /// <summary>
        /// Issue #1911: formats an explicit interface implementation's C#-style
        /// <c>IInterface.Member</c> name for use in translation diagnostics.
        /// </summary>
        private static string FormatExplicitInterfaceName(IMethodSymbol symbol)
        {
            ISymbol explicitInterfaceMember = symbol.ExplicitInterfaceImplementations[0];
            return $"{explicitInterfaceMember.ContainingType.Name}.{explicitInterfaceMember.Name}";
        }

        /// <summary>
        /// Issue #2362: property/indexer counterpart of
        /// <see cref="FindPriorCollidingSibling"/>, used for BOTH an external
        /// interface's explicit property implementation (collision-drop
        /// fallback, exactly like the method case) AND an indexer's explicit
        /// implementation of ANY interface, user or external (indexers have no
        /// distinct-name mangling available at all — see the call site in
        /// <see cref="TranslateIndexer"/> — so every indexer explicit impl uses
        /// this collision-drop path, never the mangled-name one).
        ///
        /// Unlike the method version, a return/property-TYPE mismatch does
        /// NOT exempt two candidates from colliding: G# properties have no
        /// covariant-return "bridge" mechanism (issue #985 has no property
        /// analogue), so two same-effective-name, same-parameter-shape
        /// properties always occupy the same flat-namespace slot in G#
        /// regardless of their declared type.
        /// </summary>
        private static IPropertySymbol FindPriorCollidingSiblingProperty(IPropertySymbol explicitImplementation, BasePropertyDeclarationSyntax node)
        {
            INamedTypeSymbol containingType = explicitImplementation.ContainingType;
            if (containingType == null)
            {
                return null;
            }

            string simpleName = explicitImplementation.ExplicitInterfaceImplementations[0].Name;
            int selfPosition = node.SpanStart;

            IPropertySymbol bestPublicCandidate = null;
            IPropertySymbol bestExplicitCandidate = null;
            int bestExplicitPosition = int.MaxValue;

            foreach (ISymbol member in containingType.GetMembers())
            {
                if (member is not IPropertySymbol candidate ||
                    SymbolEqualityComparer.Default.Equals(candidate, explicitImplementation) ||
                    EffectiveSimplePropertyName(candidate) != simpleName ||
                    candidate.Parameters.Length != explicitImplementation.Parameters.Length ||
                    !HasSamePropertyParameterTypes(candidate, explicitImplementation))
                {
                    continue;
                }

                if (candidate.ExplicitInterfaceImplementations.Length == 0)
                {
                    bestPublicCandidate = candidate;
                    continue;
                }

                int candidatePosition = candidate.DeclaringSyntaxReferences.FirstOrDefault()?.Span.Start ?? int.MaxValue;
                if (candidatePosition < bestExplicitPosition)
                {
                    bestExplicitCandidate = candidate;
                    bestExplicitPosition = candidatePosition;
                }
            }

            // A plain public property always wins over an explicit implementation.
            if (bestPublicCandidate != null)
            {
                return bestPublicCandidate;
            }

            // Among explicit implementations only, the earliest-declared one
            // wins; this declaration yields only if some other explicit impl is
            // strictly earlier.
            if (bestExplicitCandidate != null && bestExplicitPosition < selfPosition)
            {
                return bestExplicitCandidate;
            }

            return null;
        }

        private static string EffectiveSimplePropertyName(IPropertySymbol property)
        {
            return property.ExplicitInterfaceImplementations.Length > 0
                ? property.ExplicitInterfaceImplementations[0].Name
                : property.Name;
        }

        private static bool HasSamePropertyParameterTypes(IPropertySymbol left, IPropertySymbol right)
        {
            for (int i = 0; i < left.Parameters.Length; i++)
            {
                if (!SymbolEqualityComparer.Default.Equals(left.Parameters[i].Type, right.Parameters[i].Type))
                {
                    return false;
                }
            }

            return true;
        }

        /// <summary>
        /// Issue #2362: property/indexer counterpart of
        /// <see cref="FormatSiblingName"/>.
        /// </summary>
        private static string FormatSiblingPropertyName(IPropertySymbol sibling)
        {
            return sibling.ExplicitInterfaceImplementations.Length > 0
                ? FormatExplicitInterfacePropertyName(sibling)
                : sibling.Name;
        }

        /// <summary>
        /// Issue #2362: property/indexer counterpart of
        /// <see cref="FormatExplicitInterfaceName"/>.
        /// </summary>
        private static string FormatExplicitInterfacePropertyName(IPropertySymbol symbol)
        {
            ISymbol explicitInterfaceMember = symbol.ExplicitInterfaceImplementations[0];
            return $"{explicitInterfaceMember.ContainingType.Name}.{explicitInterfaceMember.Name}";
        }

        /// <summary>
        /// ADR-0149 (issue #2362 follow-up): event counterpart of
        /// <see cref="FindPriorCollidingSiblingProperty"/> — an event has no
        /// parameter list to disambiguate overloads by, so the match is purely
        /// on effective simple name (mirrors <see cref="FindPriorCollidingSibling"/>
        /// for methods, minus the arity/type-parameter comparison).
        /// </summary>
        private static IEventSymbol FindPriorCollidingSiblingEvent(IEventSymbol explicitImplementation, EventDeclarationSyntax node)
        {
            INamedTypeSymbol containingType = explicitImplementation.ContainingType;
            if (containingType == null)
            {
                return null;
            }

            string simpleName = explicitImplementation.ExplicitInterfaceImplementations[0].Name;
            int selfPosition = node.SpanStart;

            IEventSymbol bestPublicCandidate = null;
            IEventSymbol bestExplicitCandidate = null;
            int bestExplicitPosition = int.MaxValue;

            foreach (ISymbol member in containingType.GetMembers())
            {
                if (member is not IEventSymbol candidate ||
                    SymbolEqualityComparer.Default.Equals(candidate, explicitImplementation) ||
                    EffectiveSimpleEventName(candidate) != simpleName)
                {
                    continue;
                }

                if (candidate.ExplicitInterfaceImplementations.Length == 0)
                {
                    bestPublicCandidate = candidate;
                    continue;
                }

                int candidatePosition = candidate.DeclaringSyntaxReferences.FirstOrDefault()?.Span.Start ?? int.MaxValue;
                if (candidatePosition < bestExplicitPosition)
                {
                    bestExplicitCandidate = candidate;
                    bestExplicitPosition = candidatePosition;
                }
            }

            // A plain public event always wins over an explicit implementation.
            if (bestPublicCandidate != null)
            {
                return bestPublicCandidate;
            }

            // Among explicit implementations only, the earliest-declared one
            // wins; this declaration yields only if some other explicit impl is
            // strictly earlier.
            if (bestExplicitCandidate != null && bestExplicitPosition < selfPosition)
            {
                return bestExplicitCandidate;
            }

            return null;
        }

        private static string EffectiveSimpleEventName(IEventSymbol ev)
        {
            return ev.ExplicitInterfaceImplementations.Length > 0
                ? ev.ExplicitInterfaceImplementations[0].Name
                : ev.Name;
        }

        /// <summary>
        /// ADR-0149 (issue #2362 follow-up): event counterpart of
        /// <see cref="FormatSiblingPropertyName"/>.
        /// </summary>
        private static string FormatSiblingEventName(IEventSymbol sibling)
        {
            return sibling.ExplicitInterfaceImplementations.Length > 0
                ? FormatExplicitInterfaceEventName(sibling)
                : sibling.Name;
        }

        /// <summary>
        /// ADR-0149 (issue #2362 follow-up): event counterpart of
        /// <see cref="FormatExplicitInterfacePropertyName"/>.
        /// </summary>
        private static string FormatExplicitInterfaceEventName(IEventSymbol symbol)
        {
            ISymbol explicitInterfaceMember = symbol.ExplicitInterfaceImplementations[0];
            return $"{explicitInterfaceMember.ContainingType.Name}.{explicitInterfaceMember.Name}";
        }

        /// <summary>
        /// Whether <paramref name="kind"/> is a C# 14 instance compound-assignment
        /// operator token (<c>op_AdditionAssignment</c> and siblings).
        /// </summary>
        private static bool IsCompoundAssignmentOperatorToken(SyntaxKind kind) => kind is
            SyntaxKind.PlusEqualsToken or
            SyntaxKind.MinusEqualsToken or
            SyntaxKind.AsteriskEqualsToken or
            SyntaxKind.SlashEqualsToken or
            SyntaxKind.PercentEqualsToken or
            SyntaxKind.AmpersandEqualsToken or
            SyntaxKind.BarEqualsToken or
            SyntaxKind.CaretEqualsToken or
            SyntaxKind.LessThanLessThanEqualsToken or
            SyntaxKind.GreaterThanGreaterThanEqualsToken or
            SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;

        /// <summary>
        /// Translates a C# operator overload (<c>public static X operator +(X a, X b)</c>)
        /// to the canonical G# receiver-clause operator form
        /// <c>func (a X) operator +(b X) X</c> (ADR-0035, sample <c>Operators.gs</c>;
        /// ADR-0115 §B.5). The first operand becomes the receiver; remaining
        /// operands become parameters (a unary operator has no parameters). The
        /// declaration is lifted to a top-level sibling because a receiver-clause
        /// <c>func</c> only binds at top level.
        ///
        /// C# 14 instance compound-assignment operators (<c>operator +=</c> and
        /// siblings, <c>op_AdditionAssignment</c> etc.) have no canonical G# form
        /// — G# operator declarations are binary/unary only (ADR-0035) and there
        /// is no lossless mechanical rewrite to a binary operator, since the
        /// compound form mutates instance state in place rather than returning a
        /// new value. These are reported as an unsupported gap instead of
        /// emitting the C# token text verbatim into a <c>operator +=</c>
        /// declaration that fails to parse (issue #1908).
        /// </summary>
        private (GMember Member, bool IsStatic) TranslateOperator(OperatorDeclarationSyntax node)
        {
            string operatorToken = node.OperatorToken.Text;

            if (IsCompoundAssignmentOperatorToken(node.OperatorToken.Kind()))
            {
                string binaryToken = operatorToken.TrimEnd('=');
                string message =
                    $"C# 14 instance compound-assignment operator 'operator {operatorToken}' has no canonical " +
                    "G# form: G# operator declarations are binary/unary only (ADR-0035) and there is no lossless " +
                    $"mechanical rewrite to a binary 'operator {binaryToken}', since the compound form may " +
                    "mutate instance state beyond its return value.";
                this.context.ReportUnsupported(node, message);
                return (null, false);
            }

            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;

            List<Parameter> allParameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);
            Receiver receiver;
            List<Parameter> parameters;
            if (allParameters.Count > 0)
            {
                Parameter first = allParameters[0];
                receiver = new Receiver(first.Name, first.Type);
                parameters = allParameters.Skip(1).ToList();
            }
            else
            {
                receiver = new Receiver(
                    "self",
                    new NamedTypeReference(symbol?.ContainingType?.Name ?? "object"));
                parameters = new List<Parameter>();
            }

            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.ReturnType, this.context, node.ReturnType.GetLocation())
                : null;

            BlockStatement body = (node.Body != null || node.ExpressionBody != null)
                ? this.TranslateBody(node, $"operator '{operatorToken}'")
                : null;

            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            var method = new MethodDeclaration(
                $"operator {operatorToken}",
                parameters: parameters,
                returnType: returnType,
                body: body,
                typeParameters: null,
                receiver: receiver,
                visibility: Visibility.Default,
                isOpen: false,
                isOverride: false,
                isAsync: false,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            // Operators carry the receiver-clause form and are lifted to a top-level
            // sibling; returning IsStatic=false routes them through the existing
            // receiver-clause lift in VisitAggregate.
            return (method, false);
        }

        private (GMember Member, bool IsStatic) TranslateConversionOperator(ConversionOperatorDeclarationSyntax node)
        {
            // gsc issue #1017: `public static implicit operator T(U x)` →
            // `func operator implicit (x U) T { ... }` (and `explicit` likewise).
            // The single C# parameter is the conversion source; the C# target type
            // (`node.Type`) becomes the G# return type. `implicit`/`explicit` is a
            // contextual keyword that forms the operator name.
            string kindKeyword = node.ImplicitOrExplicitKeyword.IsKind(SyntaxKind.ImplicitKeyword)
                ? "implicit"
                : "explicit";

            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.ReturnType, this.context, node.Type.GetLocation())
                : this.MapTypeSyntax(node.Type);

            BlockStatement body = (node.Body != null || node.ExpressionBody != null)
                ? this.TranslateBody(node, $"conversion operator '{kindKeyword}'")
                : null;

            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            var method = new MethodDeclaration(
                $"operator {kindKeyword}",
                parameters: parameters,
                returnType: returnType,
                body: body,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);

            // The conversion operator has no receiver clause, so it stays an
            // in-body member of the owning type (returning IsStatic=false routes it
            // to the instance-member list in VisitAggregate, which the parser
            // accepts directly in the type body).
            return (method, false);
        }

        /// <summary>
        /// Issue #1190: a C# <c>static</c> auto-property with an inline initializer
        /// (<c>public static Version OSVersion { get; } = GetOsVersion();</c>) has no
        /// instance constructor to carry the initializer into (the OD-T1 path only
        /// services instance properties), and a static G# <c>prop</c> cannot declare
        /// an <c>init</c> accessor (GS0374). Such a property therefore maps to a
        /// static read-only/mutable backing field inside the <c>shared { }</c> block,
        /// preserving the initializer expression: a get-only property becomes a
        /// <c>shared let NAME T = expr</c> field, and a mutable
        /// (<c>{ get; private set; }</c> / <c>{ get; set; }</c>) property becomes a
        /// <c>shared var NAME T = expr</c> field. It is accessed identically
        /// (<c>Type.NAME</c>). A static auto-property without an initializer, or one
        /// with a getter body, keeps its existing handling.
        /// </summary>
        private bool TryTranslateStaticAutoPropertyField(
            PropertyDeclarationSyntax node,
            out FieldDeclaration field)
        {
            field = null;

            if (!node.Modifiers.Any(SyntaxKind.StaticKeyword) || node.Initializer == null)
            {
                return false;
            }

            // Auto-property: body-less, all accessors body-less, no expression body.
            if (node.ExpressionBody != null || node.AccessorList == null)
            {
                return false;
            }

            IReadOnlyList<AccessorDeclarationSyntax> accessors = node.AccessorList.Accessors;
            if (accessors.Any(a => a.Body != null || a.ExpressionBody != null))
            {
                return false;
            }

            bool hasGet = accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            if (!hasGet)
            {
                return false;
            }

            bool hasSet = accessors.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));

            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            GExpression initializer = this.CoerceConstantToUnsigned(
                node.Initializer.Value,
                this.TranslateNullSeamExpression(node.Initializer.Value, symbol?.ContainingType));
            initializer = this.ForgiveNullableReferenceValue(
                node.Initializer.Value,
                initializer,
                symbol?.Type,
                symbol);

            // Issue #1072: a non-nullable reference static auto-property whose
            // initializer is nullable (e.g. `GetAttribute<...>()?.Member`) is
            // rendered `T?` so the initializer assignment type-checks.
            if (symbol != null)
            {
                type = this.PromoteIfInitializerNullable(type, symbol, node.Initializer.Value);
            }

            // A mutable static auto-property (`{ get; set; }` / `{ get; private set; }`)
            // becomes a `var` field; an immutable get-only one becomes a `let` field.
            BindingKind binding = hasSet ? BindingKind.Var : BindingKind.Let;

            field = new FieldDeclaration(
                binding,
                SanitizeIdentifier(node.Identifier.Text),
                type,
                initializer: initializer,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists));

            return true;
        }

        private (GMember Member, bool IsStatic, GMember BackingField) TranslateProperty(
            PropertyDeclarationSyntax node, IReadOnlyCollection<string> primaryCtorParamNames = null)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;

            // Issue #2362, ADR-0149: explicit interface PROPERTY implementations
            // get the exact same treatment as explicit interface METHODS (issues
            // #1911/#2010/#2181) — see the extensive comment on this same
            // decision tree in TranslateMethod, which this mirrors verbatim
            // (explicit-interface qualifier clause + CLR MethodImpl bridge for a
            // G# USER interface; forced-public collision-drop fallback for an
            // EXTERNAL/BCL interface). The property-specific difference: there is
            // no covariant-return "bridge" mechanism for properties (issue #985
            // has no property analogue), so collision detection never exempts
            // a type mismatch — see FindPriorCollidingSiblingProperty.
            bool isExplicitInterfacePropertyImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            bool isUserInterfaceExplicitPropertyImpl = isExplicitInterfacePropertyImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1 &&
                symbol.ExplicitInterfaceImplementations[0].ContainingType.Locations.Any(l => l.IsInSource);

            if (isExplicitInterfacePropertyImpl && symbol.ExplicitInterfaceImplementations.Length > 1 &&
                symbol.ExplicitInterfaceImplementations.All(e => e.ContainingType.Locations.Any(l => l.IsInSource)))
            {
                string names = string.Join(", ", symbol.ExplicitInterfaceImplementations.Select(e => e.ContainingType.Name));
                string multiEntryMessage =
                    $"explicit interface property implementation '{FormatExplicitInterfacePropertyName(symbol)}' satisfies " +
                    $"more than one G# user interface member in one C# declaration ({names}), likely via interface " +
                    "inheritance (a base interface re-declaring the same property). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per property, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the property keeps its plain name " +
                    "and every interface's slot is satisfied via ordinary implicit name+signature dispatch (known gap: " +
                    "the property becomes publicly callable by name, unlike real C# explicit-impl semantics).";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.PropertyDeclaration), multiEntryMessage, node.GetLocation(), TranslationSeverity.Info));
            }

            if (isExplicitInterfacePropertyImpl && !isUserInterfaceExplicitPropertyImpl)
            {
                IPropertySymbol propertySurvivor = FindPriorCollidingSiblingProperty(symbol, node);
                if (propertySurvivor != null)
                {
                    string message =
                        $"explicit interface property implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfacePropertyName(symbol)}' " +
                        $"shares its name and signature with '{symbol.ContainingType.Name}.{FormatSiblingPropertyName(propertySurvivor)}'; " +
                        "G# has no explicit-interface-implementation surface for EXTERNAL interfaces (ADR-0091), so the " +
                        "two C# properties cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "access through the interface-typed reference that previously reached this property now " +
                        "silently observes the surviving property instead (semantic loss, known gap, issue #1911 " +
                        "analogue). This diagnostic covers only EXTERNAL/BCL interfaces — a same-signature collision " +
                        "between two G# user-interface explicit property implementations is fully supported (issue " +
                        "#2362, ADR-0149 explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.PropertyDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false, null);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a G# user-interface explicit property implementation, or null
            // otherwise (ordinary property, or external-interface explicit
            // implementation, which keeps the pre-#2010 name-based dispatch).
            GTypeReference explicitInterfacePropertyType = isUserInterfaceExplicitPropertyImpl
                ? this.typeMapper.Map(symbol.ExplicitInterfaceImplementations[0].ContainingType, this.context, node.GetLocation())
                : null;

            bool isStatic = symbol != null && symbol.IsStatic;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            // Issue #1354 / #1072: a non-nullable reference property that is
            // null-checked or null-assigned anywhere in the declaring type is
            // really nullable; render it `T?` so the `== nil`/`is null` guard
            // type-checks (gsc rejects `== nil` on a non-null operand, GS0129).
            if (symbol != null)
            {
                type = this.PromoteIfUsedAsNullable(type, symbol);
            }

            // Issue #1907: register a synthesized backing field BEFORE mapping the
            // accessor bodies below, so a `field` reference inside them (bound via
            // TranslateExpression's FieldExpressionSyntax case) resolves to it.
            string fieldKeywordBackingName = this.TryRegisterFieldKeywordBackingField(
                node, symbol, primaryCtorParamNames, out IFieldSymbol fieldKeywordBackingSymbol);

            // Issue #1907 / #1072: the backing field can be used as nullable
            // independently of the property's own declared nullability (e.g.
            // `get => field ??= "default";` lazy-inits a non-null-looking `string`
            // property from a field that starts out null) — promote off the
            // FIELD symbol's own usage, not the property's.
            GTypeReference backingType = fieldKeywordBackingSymbol != null
                ? this.PromoteIfUsedAsNullable(type, fieldKeywordBackingSymbol)
                : type;

            // Issue #1907: a property initializer (`{ get; set => ...; } = 5;`)
            // seeds the compiler-synthesized backing field, not the property
            // itself — carry it over or the field silently starts at default(T).
            GExpression backingInitializer = fieldKeywordBackingName != null && node.Initializer != null
                ? this.CoerceConstantToUnsigned(
                    node.Initializer.Value,
                    this.TranslateNullSeamExpression(node.Initializer.Value, symbol?.ContainingType))
                : null;
            GMember backingField = fieldKeywordBackingName != null
                ? new FieldDeclaration(BindingKind.Var, fieldKeywordBackingName, backingType, initializer: backingInitializer, visibility: Visibility.Private)
                : null;

            List<PropertyAccessor> accessors = this.MapAccessors(node, fieldKeywordBackingName);

            // Issue #1278 / ADR-0131: a C# expression-bodied read-only property
            // (`string Name => expr;`) renders as the idiomatic G# property-level
            // arrow `prop Name T -> expr` when its get body folds to a single
            // inline statement.
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            if (arrowBody != null)
            {
                accessors = new List<PropertyAccessor>();
            }

            bool isOverride = symbol != null && symbol.IsOverride;

            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // Issue #2362, ADR-0149: see the matching visibility comment in
            // TranslateMethod for the full rationale — a G# user-interface
            // explicit property implementation (explicit-interface clause + CLR
            // MethodImpl) keeps C#'s own `private`-equivalent visibility
            // (Roslyn reports `Private`, mapped straight through by
            // MapVisibility); an EXTERNAL/BCL interface explicit property
            // implementation still relies on name-based dispatch and must stay
            // forced-public (`Visibility.Default`, which for a class-member
            // position IS public per ADR-0115 §B.10) or ilverify would reject
            // the missing interface method.
            Visibility explicitInterfacePropertyVisibility = isExplicitInterfacePropertyImpl && !isUserInterfaceExplicitPropertyImpl
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var property = new PropertyDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                type,
                accessors: accessors,
                visibility: explicitInterfacePropertyVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfacePropertyType);

            return (property, isStatic, backingField);
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
        private string TryRegisterFieldKeywordBackingField(
            PropertyDeclarationSyntax node,
            IPropertySymbol symbol,
            IReadOnlyCollection<string> primaryCtorParamNames,
            out IFieldSymbol fieldSymbol)
        {
            fieldSymbol = null;
            if (symbol == null)
            {
                return null;
            }

            fieldSymbol = node.DescendantNodes()
                .OfType<FieldExpressionSyntax>()
                .Select(fieldExpr => this.context.GetSymbolInfo(fieldExpr).Symbol as IFieldSymbol)
                .FirstOrDefault(backingSymbol =>
                    backingSymbol != null &&
                    SymbolEqualityComparer.Default.Equals(backingSymbol.AssociatedSymbol, symbol));
            if (fieldSymbol == null)
            {
                return null;
            }

            string propName = symbol.Name;
            string baseName = "_" + (propName.Length > 0
                ? char.ToLowerInvariant(propName[0]) + propName.Substring(1)
                : propName);

            var taken = new HashSet<string>(StringComparer.Ordinal);
            foreach (ISymbol member in symbol.ContainingType.GetMembers())
            {
                taken.Add(member.Name);
            }

            if (primaryCtorParamNames != null)
            {
                taken.UnionWith(primaryCtorParamNames);
            }

            taken.UnionWith(this.state.FieldKeywordBackingFieldNames.Values);

            string candidate = baseName;
            for (int suffix = 2; taken.Contains(candidate); suffix++)
            {
                candidate = baseName + suffix;
            }

            this.state.FieldKeywordBackingFieldNames[symbol] = candidate;
            return candidate;
        }

        private List<PropertyAccessor> MapAccessors(PropertyDeclarationSyntax node, string fieldKeywordBackingName = null)
        {
            return this.MapAccessors(node, $"property '{node.Identifier.Text}'", fieldKeywordBackingName);
        }

        // Issue #1278 / ADR-0131: fold a C# expression-bodied property/indexer
        // into a property-level G# arrow `prop Name T -> expr`. Returns the
        // foldable single statement when the C# member used `=> expr` and its
        // translated get accessor is a single inline statement; otherwise null
        // (the caller keeps the get-only block accessor list).
        private static GStatement TryFoldComputedPropertyArrow(
            ArrowExpressionClauseSyntax csExpressionBody,
            List<PropertyAccessor> accessors)
        {
            if (csExpressionBody == null
                || accessors.Count != 1
                || accessors[0].Kind != AccessorKind.Get
                || accessors[0].Body == null)
            {
                return null;
            }

            return TryFoldArrowBody(accessors[0].Body);
        }
    }
}
