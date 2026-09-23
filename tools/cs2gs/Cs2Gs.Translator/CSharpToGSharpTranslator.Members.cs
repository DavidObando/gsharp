// <copyright file="CSharpToGSharpTranslator.Members.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
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
            IReadOnlyCollection<ConstructorDeclarationSyntax> callSiteLoweredStructConstructors = null,
            INamedTypeSymbol ownedExtensionTarget = null)
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
                    if (ownedExtensionTarget is null && this.CanLowerOwnedExtension(method))
                    {
                        break;
                    }

                    // A GeneratedRegex trigger is a non-void partial definition,
                    // so ordinary partial-method elision would drop its declaration
                    // while value-position calls remain.
                    if (this.TryTranslateGeneratedRegex(
                        method,
                        out FieldDeclaration generatedRegexField,
                        out MethodDeclaration generatedRegexMethod))
                    {
                        yield return (generatedRegexField, true);
                        yield return (
                            generatedRegexMethod,
                            method.Modifiers.Any(SyntaxKind.StaticKeyword));
                        break;
                    }

                    // ADR-0169 M5 / issue #3686: private plumbing of a Roslyn
                    // analyzer test harness whose body is being replaced by a
                    // delegation to the G# verifier is dead code that would
                    // otherwise drag unmapped Roslyn types into the migrated
                    // project (MetadataReference, CSharpCompilationOptions).
                    if (this.IsAnalyzerHarnessSupportMember(method))
                    {
                        break;
                    }

                    (GMember methodMember, bool methodIsStatic) = this.TranslateMethod(
                        method,
                        ownerKind,
                        ownedExtensionTarget: ownedExtensionTarget);
                    if (methodMember != null)
                    {
                        yield return (methodMember, methodIsStatic);
                    }

                    if (ownedExtensionTarget is null
                        && this.context.GetDeclaredSymbol(method) is IMethodSymbol companionSymbol
                        && this.HasReceiverCompanion(companionSymbol))
                    {
                        (GMember companion, bool companionIsStatic) = this.TranslateMethod(
                            method,
                            ownerKind,
                            forceExtensionReceiver: true);
                        if (companion != null)
                        {
                            yield return (companion, companionIsStatic);
                        }
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
                    if (ownerKind is TypeDeclarationKind.DataClass or TypeDeclarationKind.DataStruct
                        && primaryCtorParamNames?.Contains(
                            property.Identifier.Text,
                            StringComparer.Ordinal) == true
                        && propertySymbol is { IsStatic: false }
                        && property.AccessorList?.Accessors.All(accessor =>
                            accessor.Body == null
                            && accessor.ExpressionBody == null) == true)
                    {
                        break;
                    }

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
                                this.EmittedName(propertySymbol, property.Identifier.ValueText),
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

                    if (this.TryTranslateStaticInitializedAutoProperty(
                        property,
                        out FieldDeclaration staticBackingField,
                        out PropertyDeclaration staticProperty))
                    {
                        yield return (staticBackingField, true);
                        yield return (staticProperty, true);
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

        private bool TryTranslateGeneratedRegex(
            MethodDeclarationSyntax node,
            out FieldDeclaration cacheField,
            out MethodDeclaration method)
        {
            cacheField = null;
            method = null;

            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            if (symbol == null ||
                !symbol.IsPartialDefinition ||
                symbol.Parameters.Length != 0 ||
                symbol.TypeParameters.Length != 0)
            {
                return false;
            }

            AttributeData attribute = symbol.GetAttributes().FirstOrDefault(
                candidate => candidate.AttributeClass?.ToDisplayString() ==
                    "System.Text.RegularExpressions.GeneratedRegexAttribute");
            if (attribute?.AttributeConstructor == null)
            {
                return false;
            }

            string pattern = null;
            object optionsValue = 0;
            ITypeSymbol optionsType = this.context.Compilation.GetTypeByMetadataName(
                "System.Text.RegularExpressions.RegexOptions");
            int timeoutMilliseconds = -1;
            bool hasMatchTimeoutArgument = false;
            string cultureName = string.Empty;

            ImmutableArray<IParameterSymbol> constructorParameters = attribute.AttributeConstructor.Parameters;
            ImmutableArray<TypedConstant> constructorArguments = attribute.ConstructorArguments;
            if (constructorParameters.Length != constructorArguments.Length)
            {
                return false;
            }

            for (int i = 0; i < constructorParameters.Length; i++)
            {
                object value = constructorArguments[i].Value;
                switch (constructorParameters[i].Name)
                {
                    case "pattern":
                        pattern = value as string;
                        break;
                    case "options":
                        optionsValue = value;
                        optionsType = constructorArguments[i].Type ?? optionsType;
                        break;
                    case "matchTimeoutMilliseconds" when value is int timeoutArgument:
                        timeoutMilliseconds = timeoutArgument;
                        hasMatchTimeoutArgument = true;
                        break;
                    case "cultureName":
                        cultureName = value as string ?? string.Empty;
                        break;
                }
            }

            if (pattern == null || optionsType == null)
            {
                return false;
            }

            long optionBits = Convert.ToInt64(optionsValue, CultureInfo.InvariantCulture);
            const long IgnoreCase = 1;
            const long CultureInvariant = 512;
            bool usesIgnoreCase = (optionBits & IgnoreCase) != 0 ||
                PatternEnablesInlineIgnoreCase(pattern);
            if (usesIgnoreCase &&
                ((optionBits & CultureInvariant) == 0 || cultureName.Length > 0))
            {
                const string Message = "GeneratedRegex with culture-sensitive IgnoreCase, including inline " +
                    "option groups, cannot be lowered to Regex construction without changing culture or " +
                    "Regex.Options semantics.";
                this.context.ReportUnsupported(node, Message);
                return false;
            }

            GTypeReference regexType = this.typeMapper.Map(
                symbol.ReturnType,
                this.context,
                node.ReturnType.GetLocation());
            GExpression options = this.MapConstantValue(
                optionsValue,
                optionsType,
                node,
                "GeneratedRegex options");
            if (options == null)
            {
                return false;
            }

            var constructionArguments = new List<GExpression>
            {
                LiteralExpression.String(pattern),
                options,
            };
            if (hasMatchTimeoutArgument)
            {
                string regexTypeName = regexType is NamedTypeReference namedRegex
                    ? namedRegex.Name
                    : "Regex";
                GExpression matchTimeout = timeoutMilliseconds == -1
                    ? new MemberAccessExpression(
                        new IdentifierExpression(regexTypeName),
                        "InfiniteMatchTimeout")
                    : new InvocationExpression(
                        new MemberAccessExpression(
                            new IdentifierExpression("TimeSpan"),
                            "FromMilliseconds"),
                        new[]
                        {
                            LiteralExpression.Float(
                                timeoutMilliseconds.ToString(CultureInfo.InvariantCulture) + ".0"),
                        });
                constructionArguments.Add(matchTimeout);
            }

            string emittedMethodName = this.EmittedName(symbol, node.Identifier.ValueText);
            string cacheName = "__generatedRegex_" + emittedMethodName;
            var occupiedNames = new HashSet<string>(
                symbol.ContainingType.GetMembers().Select(member => member.Name),
                StringComparer.Ordinal);
            while (occupiedNames.Contains(cacheName))
            {
                cacheName += "_";
            }

            cacheField = new FieldDeclaration(
                BindingKind.Let,
                cacheName,
                regexType,
                BuildConstruction(regexType, constructionArguments),
                Visibility.Private);

            List<AttributeUse> attributes = this.MapAttributes(node.AttributeLists)
                .Where(mapped => !IsGeneratedRegexAttributeName(mapped.Name))
                .ToList();
            method = new MethodDeclaration(
                emittedMethodName,
                returnType: regexType,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: attributes,
                expressionBody: new ReturnStatement(new IdentifierExpression(cacheName)));
            return true;
        }

        private static bool IsGeneratedRegexAttributeName(string name)
        {
            string simpleName = name.Substring(name.LastIndexOf('.') + 1);
            return simpleName == "GeneratedRegex" || simpleName == "GeneratedRegexAttribute";
        }

        private static bool PatternEnablesInlineIgnoreCase(string pattern)
        {
            bool inCharacterClass = false;
            bool firstCharacterInClass = false;

            for (int i = 0; i < pattern.Length; i++)
            {
                char current = pattern[i];
                if (current == '\\')
                {
                    if (inCharacterClass)
                    {
                        firstCharacterInClass = false;
                    }

                    i++;
                    continue;
                }

                if (inCharacterClass)
                {
                    if (current == ']' && !firstCharacterInClass)
                    {
                        inCharacterClass = false;
                    }
                    else if (current != '^' || !firstCharacterInClass)
                    {
                        firstCharacterInClass = false;
                    }

                    continue;
                }

                if (current == '[')
                {
                    inCharacterClass = true;
                    firstCharacterInClass = true;
                    continue;
                }

                if (current != '(' ||
                    i + 2 >= pattern.Length ||
                    pattern[i + 1] != '?')
                {
                    continue;
                }

                if (pattern[i + 2] == '#')
                {
                    int commentEnd = pattern.IndexOf(')', i + 3);
                    if (commentEnd < 0)
                    {
                        return false;
                    }

                    i = commentEnd;
                    continue;
                }

                if (InlineOptionsEnableIgnoreCase(pattern, i + 2))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool InlineOptionsEnableIgnoreCase(string pattern, int start)
        {
            bool disabling = false;
            bool sawOption = false;
            bool sawDisabledOption = false;
            bool enabledIgnoreCase = false;
            bool disabledIgnoreCase = false;
            int i = start;

            for (; i < pattern.Length; i++)
            {
                char option = pattern[i];
                if (option == '-')
                {
                    if (disabling)
                    {
                        return false;
                    }

                    disabling = true;
                    continue;
                }

                if (option is not ('i' or 'm' or 'n' or 's' or 'x'))
                {
                    break;
                }

                sawOption = true;
                if (disabling)
                {
                    sawDisabledOption = true;
                    disabledIgnoreCase |= option == 'i';
                }
                else
                {
                    enabledIgnoreCase |= option == 'i';
                }
            }

            return sawOption &&
                (!disabling || sawDisabledOption) &&
                i < pattern.Length &&
                pattern[i] is ')' or ':' &&
                enabledIgnoreCase &&
                !disabledIgnoreCase;
        }

        private bool CanLowerOwnedExtension(MethodDeclarationSyntax method)
        {
            if (!this.ownedExtensions.Contains(method))
            {
                return false;
            }

            using IDisposable modelScope = this.context.UseSemanticModelFor(method.SyntaxTree);
            if (this.context.GetDeclaredSymbol(method) is not IMethodSymbol symbol ||
                !symbol.IsExtensionMethod ||
                symbol.Parameters.Length == 0)
            {
                return false;
            }

            IParameterSymbol receiver = symbol.Parameters[0];
            return receiver.RefKind == RefKind.None &&
                receiver.Type is INamedTypeSymbol receiverType &&
                (receiverType.TypeKind == TypeKind.Class || receiverType.TypeKind == TypeKind.Struct) &&
                !IsGenericReceiver(receiverType) &&
                !this.ShouldPromoteToNullableReference(receiver);
        }

        // RequiresExplicitExtensionReceiver (issue #3357) retired by
        // ADR-0182: every receiver clause prints identically now, whether
        // the receiver is an enum, an owned type, or an ordinary
        // cross-package/CLR type, so there is no longer a translation-time
        // decision to make here.

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
                && receiverParameter.Identifier.ValueText.Length > 0;

            Receiver receiver = null;
            if (hasNamedReceiver)
            {
                var receiverSymbol = this.context.GetDeclaredSymbol(receiverParameter) as IParameterSymbol;
                GTypeReference receiverType = receiverSymbol != null
                    ? this.typeMapper.Map(receiverSymbol.Type, this.context, receiverParameter.GetLocation())
                    : this.MapTypeSyntax(receiverParameter.Type);

                receiver = new Receiver(
                    this.EmittedName(receiverSymbol, receiverParameter.Identifier.ValueText),
                    receiverType);
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

            // Issue #3879: an EXTENSION property lowers to a receiver-clause
            // `func`, not to a `prop`, so the #3879 `prop … ref T` spelling does
            // not reach it — and this path never carried `isRefReturn` onto the
            // MethodDeclaration it builds. Gap rather than silently emit a
            // copy-returning function (the #3839 hazard).
            if (symbol != null && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly))
            {
                string refExtensionPropertyMessage =
                    $"ref-returning extension property '{node.Identifier.Text}' has no G# form: an extension property " +
                    "lowers to a receiver-clause `func` (ADR-0115 §B.19), and the by-ref return is not carried across " +
                    "that lowering. Emitting it would silently return a copy (issues #3839 / #3879).";
                this.context.ReportUnsupported(node, refExtensionPropertyMessage);
            }

            GTypeReference returnType = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            List<PropertyAccessor> accessors = this.MapAccessors(node);
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            BlockStatement body = arrowBody == null
                ? accessors.FirstOrDefault(a => a.Kind == AccessorKind.Get)?.Body
                : null;

            var method = new MethodDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
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
                    this.EmittedName(symbol, declarator.Identifier.ValueText),
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
            // `event (IFoo) Changed T`, using the same clause + CLR MethodImpl
            // bridge as every other member kind. Source and imported CLR
            // interfaces both resolve through the clause. Only the
            // custom add/remove accessor form (this method) can carry an explicit
            // interface specifier in C# — a field-like event never can — so
            // TranslateEventField needs no matching change.
            bool isExplicitInterfaceEventImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            bool usesExplicitInterfaceEventClause = isExplicitInterfaceEventImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1;

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

            if (isExplicitInterfaceEventImpl && !usesExplicitInterfaceEventClause)
            {
                IEventSymbol eventSurvivor = FindPriorCollidingSiblingEvent(symbol, node);
                if (eventSurvivor != null)
                {
                    string message =
                        $"explicit interface event implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfaceEventName(symbol)}' " +
                        $"shares its name with '{symbol.ContainingType.Name}.{FormatSiblingEventName(eventSurvivor)}'; " +
                        "one C# declaration targets multiple interface slots, while ADR-0149 carries one qualifier, so the " +
                        "two events cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "subscription through the interface-typed reference that previously reached this event now " +
                        "silently observes the surviving event instead (semantic loss, known gap, issue #1911 " +
                        "analogue). Separate explicit declarations with distinct qualifiers are fully supported (issue " +
                        "#2362 follow-up, ADR-0149 explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.EventDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type for
            // a single-slot explicit event implementation, or null otherwise.
            GTypeReference explicitInterfaceEventType = usesExplicitInterfaceEventClause
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
            // explicit event implementation (explicit-interface clause + CLR
            // MethodImpl) keeps C#'s own `private`-equivalent visibility.
            Visibility eventVisibility = isExplicitInterfaceEventImpl && !usesExplicitInterfaceEventClause
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var declaration = new EventDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
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
            // `delegate Name(params) R` (ADR-0059). Generic delegates;
            // (issue #1960) carry their type parameters into the bracket section,
            // `delegate Name[T](params) R` — gsc's binder/emitter;
            // support this (ADR-0059 "Follow-up work", issue #1503; GS0234 retired).
            var symbol = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol;
            IMethodSymbol invoke = symbol?.DelegateInvokeMethod;

            List<Parameter> parameters = this.MapParameterList(node.ParameterList);
            GTypeReference returnType = invoke != null
                ? this.MapDelegateLikeReturnType(invoke, isAsync: false, node.ReturnType.GetLocation())
                : this.MapTypeSyntax(node.ReturnType);
            List<TypeParameter> typeParameters = this.MapTypeParameters(symbol);
            bool isNested = symbol?.ContainingType != null;
            string name = isNested
                ? this.typeMapper.LiftedNestedDelegateName(symbol, this.context)
                : this.EmittedName(symbol, node.Identifier.ValueText);
            Visibility visibility = MapVisibility(symbol, this.context, node);
            if (isNested)
            {
                if (visibility == Visibility.Private)
                {
                    visibility = Visibility.Internal;
                }

                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.DelegateDeclaration),
                    $"nested delegate '{symbol.ToDisplayString()}' lifted to top-level '{name}' because G# named delegate declarations are top-level-only; non-public visibility is emitted as internal (ADR-0059/ADR-0110).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            return new NamedDelegateDeclaration(
                name,
                parameters,
                returnType,
                visibility,
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
            type == SpecialType.System_SByte
                || type == SpecialType.System_Int16
                || type == SpecialType.System_Int32
                || type == SpecialType.System_Int64;

        private static bool IsUnsignedIntegerSpecialType(SpecialType type) =>
            type == SpecialType.System_Byte
                || type == SpecialType.System_UInt16
                || type == SpecialType.System_UInt32
                || type == SpecialType.System_UInt64;

        private IEnumerable<(GMember Member, bool IsStatic)> TranslateField(
            FieldDeclarationSyntax field,
            ConstructorLift lift)
        {
            foreach (VariableDeclaratorSyntax declarator in field.Declaration.Variables)
            {
                var symbol = this.context.GetDeclaredSymbol(declarator) as IFieldSymbol;

                // T2: a field that became a primary-constructor parameter is no
                // longer a standalone member (the parameter declares the field).
                if (lift.FieldsAsPrimaryParameters.Contains(declarator.Identifier.ValueText))
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
                if (this.widenObliviousReferenceFields
                    && symbol?.Type?.IsReferenceType == true
                    && symbol.Type.NullableAnnotation == NullableAnnotation.None)
                {
                    type = MakeNullable(type);
                }

                // Issue #1072: a non-nullable reference/array field that is
                // null-checked or null-assigned anywhere in the declaring type is
                // really nullable; render it `T?` so the `== nil` guard type-checks.
                if (symbol != null)
                {
                    type = this.PromoteIfUsedAsNullable(type, symbol);
                    type = this.PromoteIfGeneratedPropertyTargetNullable(type, symbol);

                    // Issue #3848 (family B): a generated `T[]` field written a
                    // maybe-null ELEMENT renders `[]T?`.
                    type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol);
                }

                // T2: a field initializer (ADR-0115 §B.3) comes either from a
                // constructor assignment independent of the constructor parameters
                // (lifted out of the dropped `init`) or from a C# field initializer.
                GExpression initializer = null;
                if (lift.FieldInitializers.TryGetValue(declarator.Identifier.ValueText, out GExpression lifted))
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
                        this.TranslateNullSeamExpression(declarator.Initializer.Value));
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
                    this.EmittedName(symbol, declarator.Identifier.ValueText),
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
            Receiver forcedReceiver = null,
            INamedTypeSymbol ownedExtensionTarget = null,
            bool forceExtensionReceiver = false,
            IMethodSymbol declaringPartSignature = null)
        {
            var symbol = declaringPartSignature ?? this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            bool isStatic = symbol != null && symbol.IsStatic;
            bool isOrdinaryMemberPosition = forcedReceiver == null
                && ownedExtensionTarget == null
                && !forceExtensionReceiver;

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
            if (symbol != null && symbol.IsPartialDefinition)
            {
                if (isOrdinaryMemberPosition
                    && this.IsEmittablePartialMethodPair(symbol, ownerKind, out _))
                {
                    return this.TranslateMethod(
                        node,
                        ownerKind,
                        declaringPartSignature: symbol.PartialImplementationPart);
                }

                return (null, false);
            }

            bool isDeclaringPart = declaringPartSignature != null;

            // The node whose BODY carries implementation-only signature facts
            // (iterator `yield`, suspending calls): the implementation's own
            // node, also when `node` is the definition being spelled.
            MethodDeclarationSyntax signatureFactsNode = isDeclaringPart
                ? declaringPartSignature.DeclaringSyntaxReferences[0].GetSyntax() as MethodDeclarationSyntax ?? node
                : node;
            bool isPartialPart = isDeclaringPart
                || (isOrdinaryMemberPosition
                    && symbol?.PartialDefinitionPart is IMethodSymbol partialDefinition
                    && this.IsEmittablePartialMethodPair(partialDefinition, ownerKind, out _));

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
            bool isExplicitInterfaceImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

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
            bool hasSingleExplicitInterfaceImpl = isExplicitInterfaceImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1;
            bool hasClauseCompatibleExplicitInterfaceImpl = hasSingleExplicitInterfaceImpl;

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

            if (isExplicitInterfaceImpl && !hasClauseCompatibleExplicitInterfaceImpl)
            {
                IMethodSymbol survivor = FindPriorCollidingSibling(symbol, node);
                if (survivor != null)
                {
                    string message =
                        $"explicit interface implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfaceName(symbol)}' " +
                        $"shares its name and signature with '{symbol.ContainingType.Name}.{FormatSiblingName(survivor)}'; " +
                        "a G# explicit-interface clause cannot safely represent this interface shape, so the " +
                        "colliding C# methods cannot both be emitted (would be an exact-signature duplicate, GS0264). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's body differs from this dropped declaration's body, any C# " +
                        "call through the interface-typed reference that previously reached this body now silently " +
                        "observes the surviving method's body instead (semantic loss, known gap, issue #1911).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.MethodDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a clause-compatible explicit implementation, or null for an
            // ordinary method / safe fallback.
            GTypeReference explicitInterfaceType = hasClauseCompatibleExplicitInterfaceImpl
                ? this.typeMapper.Map(symbol.ExplicitInterfaceImplementations[0].ContainingType, this.context, node.GetLocation())
                : null;

            Receiver receiver = null;
            bool skipFirstParameter = false;
            IParameterSymbol ownedExtensionSelf = null;

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
                IParameterSymbol self = symbol.Parameters.FirstOrDefault();
                if (self != null && ownedExtensionTarget != null)
                {
                    // Issue #2821: a same-package source receiver is owned by
                    // this output package. Emit the extension as an in-body
                    // member and preserve its former `this` parameter as a local
                    // copy of the real instance for the translated body.
                    ownedExtensionSelf = self;
                    skipFirstParameter = true;
                    isStatic = false;
                }
                else if (self != null &&
                    (forceExtensionReceiver ||
                        !this.IsStaticExtensionHelper(symbol)))
                {
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
                    GTypeReference receiverType = this.typeMapper.Map(self.Type, this.context, node.GetLocation());
                    receiverType = this.PromoteIfUsedAsNullable(receiverType, self);
                    receiver = new Receiver(
                        this.EmittedName(self, self.Name),
                        receiverType);
                    skipFirstParameter = true;
                    isStatic = false;
                }
            }

            List<Parameter> parameters = isDeclaringPart
                ? symbol.Parameters
                    .Select((parameter, index) => this.MapParameter(
                        parameter,
                        node.ParameterList,
                        spellingLocation: symbol.PartialDefinitionPart.Parameters[index].Locations.FirstOrDefault()))
                    .ToList()
                : this.MapParameters(symbol, node.ParameterList, skipFirstParameter);
            if (isPartialPart)
            {
                parameters = this.ReconcilePartialMethodParameters(symbol, parameters, isDeclaringPart);
            }

            // ADR-0174 D4: an `async ValueTask`/`ValueTask<T>` method that
            // touches the Gsharp.Concurrency runtime (or carries [Suspending])
            // is a G# `suspend func`; its return type is the awaited result,
            // exactly as B.23 unwraps `async Task<T>`.
            bool isEmittedSuspend = symbol != null && this.IsSuspendingCandidate(symbol, signatureFactsNode);
            GTypeReference returnType = this.MapReturnType(
                symbol,
                node,
                unwrapValueTask: isEmittedSuspend,
                iteratorBodySource: signatureFactsNode);
            List<TypeParameter> typeParameters = this.MapMethodTypeParameters(
                symbol,
                isDeclaringPart ? symbol.PartialDefinitionPart : null);

            // ADR-0192: the declaring part is signature-only — the
            // implementation's body is translated once, by the implementing
            // part, never here (a second translation would report its body
            // diagnostics twice).
            bool hasBody = !isDeclaringPart && (node.Body != null || node.ExpressionBody != null);
            BlockStatement body;
            bool isAnalyzerHarness = false;
            if (hasBody
                && this.TryBuildAnalyzerHarnessBody(symbol, parameters, node, out BlockStatement harnessBody))
            {
                body = harnessBody;
                isAnalyzerHarness = true;

                // The C# harness was `async Task`, which G# spells as an
                // `async func` with NO declared return type (the modifier
                // synthesizes the envelope). The rewrite drops `async`, so the
                // Task envelope has to come back explicitly — the migrated
                // [Fact] methods `return` this call.
                if (returnType is null && ReturnsTask(symbol))
                {
                    returnType = this.typeMapper.Map(symbol.ReturnType, this.context, node.GetLocation());
                }
            }
            else if (hasBody
                && forceExtensionReceiver
                && RequiresOwnerScopedExtension(symbol))
            {
                body = this.BuildOwnerScopedExtensionCompanionBody(
                    symbol,
                    receiver,
                    parameters,
                    returnType);
            }
            else
            {
                body = hasBody
                    ? this.TranslateBody(node, $"method '{node.Identifier.Text}'")
                    : null;
            }

            if (body != null && ownedExtensionSelf != null)
            {
                var statements = new List<GStatement>(body.Statements.Count + 1)
                {
                    new LocalDeclarationStatement(
                        BindingKind.Var,
                        this.EmittedName(ownedExtensionSelf, ownedExtensionSelf.Name),
                        initializer: new ThisExpression()),
                };
                statements.AddRange(body.Statements);
                body = new BlockStatement(statements);
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

            bool isAsyncVoidHandler = IsCSharpAsyncVoidHandler(symbol);

            bool isOverride = symbol != null && symbol.IsOverride;

            // Interface members are implicitly abstract in C#; in canonical G# the
            // members of an `interface` carry no modifier (the `open` keyword is for
            // virtual/abstract members of a class). Suppress `open` for them so the
            // emitted G# round-trips (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // Receiver-clause methods and value-aggregate members have no
            // `open`/`override`: G# value aggregates expose no open base method
            // to override. Drop the modifiers so the emitted G# binds.
            if (receiver != null || IsValueAggregate(ownerKind))
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
            GStatement arrowBody =
                !isAsyncVoidHandler
                && ownerKind != TypeDeclarationKind.Interface
                && body != null
                && node.ExpressionBody != null
                    ? TryFoldArrowBody(body)
                    : null;
            if (arrowBody != null)
            {
                body = null;
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
            Visibility explicitInterfaceVisibility = isExplicitInterfaceImpl && !hasClauseCompatibleExplicitInterfaceImpl
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            // A rewritten analyzer test harness (#3686) delegates to the
            // synchronous G# verifier: there is nothing left to await, and an
            // `async` func returning `Task` cannot `return` a value.
            bool isEmittedAsync = !isAnalyzerHarness && !isEmittedSuspend && symbol != null && symbol.IsAsync;

            // ADR-0192 §C: method-level attributes are unioned across the
            // parts by gsc, so each part carries only its OWN — `node` is the
            // C# definition for the declaring part (the pre-ADR-0192
            // implementation-only translation silently dropped its
            // attributes).
            var method = new MethodDeclaration(
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
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfaceType,
                isRefReturn: symbol != null && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly),
                isReadOnlyRefReturn: symbol?.ReturnsByRefReadonly == true,
                isSuspend: isEmittedSuspend,
                isPartial: isPartialPart,
                partialPairKey: isPartialPart ? PartialPairKeyOf(symbol) : null);

            return (method, isStatic);
        }

        /// <summary>
        /// ADR-0143 2026-09-23 amendment / ADR-0192: whether the implemented
        /// C# partial method <paramref name="definition"/> translates to a G#
        /// declaring part plus implementing part rather than to a single
        /// ordinary method. Evaluated identically from the definition node and
        /// from the implementation node, so the implementing part is marked
        /// <c>partial</c> exactly when the declaring part is emitted.
        /// </summary>
        /// <param name="definition">The partial method's defining-part symbol.</param>
        /// <param name="ownerKind">The G# kind of the containing type.</param>
        /// <param name="implementationNode">The implementing part's declaration, when eligible.</param>
        /// <returns><see langword="true"/> when both parts are emitted.</returns>
        private bool IsEmittablePartialMethodPair(
            IMethodSymbol definition,
            TypeDeclarationKind ownerKind,
            out MethodDeclarationSyntax implementationNode)
        {
            implementationNode = null;

            // Legacy issue #1910 merge mode produces ONE non-partial G# type,
            // where a `partial func` is GS0608. G# partial methods live only in
            // a `partial class` / `partial struct` (ADR-0192 §A): records map to
            // `data class`/`data struct` and interfaces reject them (GS0607).
            if (!this.emitPartialMethodPairs
                || !this.preservePartialParts
                || ownerKind is not (TypeDeclarationKind.Class or TypeDeclarationKind.Struct)
                || !definition.IsPartialDefinition
                || definition.PartialImplementationPart is not IMethodSymbol implementation)
            {
                return false;
            }

            // A pair the reconciliation loop demoted (its parts spelled
            // different signatures): translate exactly as with pairs off.
            // Checked before anything is mapped, so the re-translated file
            // records no import or alias for the dropped declaring part.
            if (this.suppressedPartialPairKeys?.Contains(PartialPairKeyOf(implementation)) == true)
            {
                return false;
            }

            // Shapes G# cannot spell as a partial method (ADR-0192 §F, GS0607):
            // cs2gs lowers an extension method to a receiver-clause func (or
            // moves it into its receiver type, issue #2821), and an explicit
            // interface implementation carries a qualifier clause. A partial
            // method of the hoisted C# entry class becomes a top-level func.
            // An `extern` implementation (a P/Invoke-style body) has no G#
            // implementing-part spelling.
            if (definition.IsExtensionMethod
                || implementation.IsExtern
                || definition.ExplicitInterfaceImplementations.Length > 0
                || implementation.ExplicitInterfaceImplementations.Length > 0
                || (this.entryType != null
                    && SymbolEqualityComparer.Default.Equals(
                        definition.ContainingType?.OriginalDefinition,
                        this.entryType.OriginalDefinition)))
            {
                return false;
            }

            // C# only warns (CS8826) when the parts name a parameter
            // differently; G# requires identical names on both parts (GS0611),
            // and each name is observable to callers passing arguments by name.
            // There is no faithful G# spelling, so keep the pre-ADR-0192 shape.
            if (definition.Parameters.Length != implementation.Parameters.Length
                || definition.Parameters
                    .Zip(implementation.Parameters, (d, i) => d.Name == i.Name)
                    .Any(sameName => !sameName))
            {
                return false;
            }

            if (definition.DeclaringSyntaxReferences.Length != 1
                || implementation.DeclaringSyntaxReferences.Length != 1
                || definition.DeclaringSyntaxReferences[0].GetSyntax() is not MethodDeclarationSyntax definitionNode
                || implementation.DeclaringSyntaxReferences[0].GetSyntax() is not MethodDeclarationSyntax implNode)
            {
                return false;
            }

            // Both parts must be hand-authored source that this translation
            // emits. A part in a generated document is dropped by cs2gs and
            // regenerated at build by gsgen (ADR-0143 §A / ADR-0145) — the
            // common case is a generator-declared `partial void OnXChanged(T)`
            // hook with a user-written implementation — so emitting the other
            // part as `partial func` would leave it without its partner
            // (GS0610). See IsHandAuthoredTranslatedTree for the signal.
            if (!this.IsHandAuthoredTranslatedTree(definitionNode.SyntaxTree)
                || !this.IsHandAuthoredTranslatedTree(implNode.SyntaxTree))
            {
                return false;
            }

            // Out of scope for this slice: `[GeneratedRegex]` keeps its own
            // TryTranslateGeneratedRegex rewrite, and an ADR-0169 analyzer test
            // harness rewrite changes the implementation's signature (drops
            // `async`) in a way the declaring part would not see.
            if (definition.GetAttributes().Any(attribute =>
                    attribute.AttributeClass?.ToDisplayString() ==
                        "System.Text.RegularExpressions.GeneratedRegexAttribute")
                || this.IsAnalyzerHarnessEntry(implementation)
                || this.IsAnalyzerHarnessSupportMemberInOwnTree(definitionNode)
                || this.IsAnalyzerHarnessSupportMemberInOwnTree(implNode))
            {
                return false;
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
            if (definitionNode.SyntaxTree != implNode.SyntaxTree
                && definition.Parameters.Concat(implementation.Parameters).Any(HasParameterAttributes))
            {
                return false;
            }

            implementationNode = implNode;
            return true;
        }

        // Both parts are built from the implementation's symbol, so its
        // documentation-comment id (containing type + name + parameter types)
        // identifies the pair across every unit of the compilation.
        private static string PartialPairKeyOf(IMethodSymbol implementation) =>
            implementation.GetDocumentationCommentId() ?? implementation.ToDisplayString();

        private static bool HasParameterAttributes(IParameterSymbol parameter) =>
            parameter.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is ParameterSyntax
            {
                AttributeLists.Count: > 0,
            };

        // The two parts of a pair may live in different files, and this check
        // runs from either part's node, so it resolves symbols through the
        // node's OWN tree's semantic model.
        private bool IsAnalyzerHarnessSupportMemberInOwnTree(MethodDeclarationSyntax method)
        {
            using IDisposable modelScope = this.context.UseSemanticModelFor(method.SyntaxTree);
            return this.IsAnalyzerHarnessSupportMember(method);
        }

        /// <summary>
        /// Whether <paramref name="tree"/> is a hand-authored C# document this
        /// translation emits — the same file set <c>CSharpProjectLoader</c>
        /// keeps. When the caller supplies <c>retainedFilePaths</c> (a project
        /// with analyzer/generator references, issue #2215) the tree must be in
        /// it: source-generator output is excluded from that set. In every case
        /// the tree must not be build-generated by the loader's own rule
        /// (<see cref="GeneratedSourceDetection.IsGeneratedSource"/>: under the
        /// project's obj/bin directory, when the caller supplied it, or
        /// carrying the <c>&lt;auto-generated&gt;</c> header).
        /// </summary>
        private bool IsHandAuthoredTranslatedTree(Microsoft.CodeAnalysis.SyntaxTree tree) =>
            (this.retainedFilePaths == null || this.retainedFilePaths.Contains(tree.FilePath))
            && !GeneratedSourceDetection.IsGeneratedSource(tree, this.projectDirectory);

        /// <summary>
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
        /// </summary>
        private List<Parameter> ReconcilePartialMethodParameters(
            IMethodSymbol symbol,
            List<Parameter> parameters,
            bool isDeclaringPart)
        {
            IMethodSymbol definition = symbol.PartialDefinitionPart ?? symbol;
            var reconciled = new List<Parameter>(parameters.Count);
            for (int i = 0; i < parameters.Count; i++)
            {
                Parameter mapped = parameters[i];
                IParameterSymbol definitionParameter = definition.Parameters[i];
                IParameterSymbol ownParameter = isDeclaringPart ? definitionParameter : symbol.Parameters[i];
                SyntaxNode ownParameterSyntax = ownParameter.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
                GExpression defaultValue = this.BuildOptionalParameterDefault(
                    definitionParameter,
                    mapped.Type,
                    ownParameterSyntax,
                    spellingNode: ownParameterSyntax);
                var attributes = new List<AttributeUse>();
                foreach (IParameterSymbol part in new[] { definitionParameter, symbol.Parameters[i] })
                {
                    if (part.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() is ParameterSyntax partSyntax)
                    {
                        attributes.AddRange(this.MapAttributes(partSyntax.AttributeLists));
                    }
                }

                reconciled.Add(new Parameter(
                    mapped.Name,
                    mapped.Type,
                    mapped.IsVariadic,
                    mapped.RefKind,
                    defaultValue,
                    attributes));
            }

            return reconciled;
        }

        private BlockStatement BuildOwnerScopedExtensionCompanionBody(
            IMethodSymbol method,
            Receiver receiver,
            IReadOnlyList<Parameter> parameters,
            GTypeReference returnType)
        {
            IMethodSymbol original = method.ReducedFrom ?? method;
            var arguments = new List<GExpression>(parameters.Count + 1)
            {
                new IdentifierExpression(receiver.Name),
            };
            for (int index = 0; index < parameters.Count; index++)
            {
                GExpression argument = new IdentifierExpression(parameters[index].Name);
                if (original.Parameters[index + 1].RefKind == RefKind.Ref
                    || original.Parameters[index + 1].RefKind == RefKind.Out)
                {
                    argument = new UnaryExpression("&", argument);
                }

                arguments.Add(argument);
            }

            IReadOnlyList<GTypeReference> typeArguments = original.TypeParameters
                .Select(parameter =>
                    (GTypeReference)new NamedTypeReference(
                        this.EmittedName(parameter, parameter.Name)))
                .ToList();

            var call = new InvocationExpression(
                new MemberAccessExpression(
                    new IdentifierExpression(
                        this.EmittedName(original.ContainingType, original.ContainingType.Name)),
                    this.EmittedName(original, original.Name)),
                arguments,
                typeArguments);
            INamedTypeSymbol asyncEnvelope = original.IsAsync
                && original.ReturnType is INamedTypeSymbol taskLike
                && taskLike.Name is "Task" or "ValueTask"
                && taskLike.ContainingNamespace?.ToDisplayString()
                    == "System.Threading.Tasks"
                    ? taskLike
                    : null;
            GExpression forwarded = asyncEnvelope != null
                ? new AwaitExpression(call)
                : call;
            GStatement statement = returnType == null
                || asyncEnvelope is { IsGenericType: false }
                ? new ExpressionStatement(forwarded)
                : new ReturnStatement(forwarded);
            return new BlockStatement(new[] { statement });
        }

        private bool HasReceiverCompanion(IMethodSymbol method)
        {
            if (!this.ownedExtensions.HasReceiverCompanion(method))
            {
                return false;
            }

            IMethodSymbol original = method?.ReducedFrom ?? method;
            return !RequiresOwnerScopedExtension(original)
                || this.CanEmitOwnerScopedReceiverCompanion(original);
        }

        private bool CanEmitOwnerScopedReceiverCompanion(IMethodSymbol method)
        {
            IMethodSymbol original = method?.ReducedFrom ?? method;
            if (!IsOwnerScopedCompanionShapeEligible(original))
            {
                return false;
            }

            if (original.Parameters[0].Type is INamedTypeSymbol receiver
                && this.HasCanonicalReducedDeclarationCollision(
                    receiver.OriginalDefinition,
                    original))
            {
                return false;
            }

            string signature = this.CanonicalExtensionSignature(original);
            string identity = ExtensionMethodIdentity(original);
            var ownerCandidates = new HashSet<string>(StringComparer.Ordinal)
            {
                identity,
            };

            // A referenced project wins over its dependent: the dependency can
            // emit without knowing reverse dependents exist, while the dependent
            // sees the dependency through SiblingCompilations. Assembly + doc ID
            // deduplicates that source method's metadata copy.
            foreach (IMethodSymbol candidate in this.EnumerateKnownExtensionMethods(original))
            {
                IMethodSymbol candidateOriginal = candidate.ReducedFrom ?? candidate;
                string candidateIdentity = ExtensionMethodIdentity(candidateOriginal);
                if (candidateIdentity == identity
                    || this.CanonicalExtensionSignature(candidateOriginal) != signature)
                {
                    continue;
                }

                if (!RequiresOwnerScopedExtension(candidateOriginal))
                {
                    return false;
                }

                if (IsOwnerScopedCompanionShapeEligible(candidateOriginal))
                {
                    if (CompilationReferencesAssembly(
                        this.context.Compilation,
                        candidateOriginal.ContainingAssembly))
                    {
                        return false;
                    }

                    CSharpCompilation candidateCompilation =
                        this.KnownCompilations().FirstOrDefault(compilation =>
                            SameAssembly(
                                compilation.Assembly,
                                candidateOriginal.ContainingAssembly));
                    if (candidateCompilation != null
                        && CompilationReferencesAssembly(
                            candidateCompilation,
                            this.context.Compilation.Assembly))
                    {
                        continue;
                    }

                    ownerCandidates.Add(candidateIdentity);
                }
            }

            return string.Equals(
                identity,
                ownerCandidates.Min(StringComparer.Ordinal),
                StringComparison.Ordinal);
        }

        private bool HasCanonicalReducedDeclarationCollision(
            INamedTypeSymbol receiver,
            IMethodSymbol extension)
        {
            string extensionSignature =
                this.CanonicalReducedSignature(extension, parameterOffset: 1);
            string emittedName = this.EmittedName(extension, extension.Name);
            for (INamedTypeSymbol current = receiver; current != null; current = current.BaseType)
            {
                foreach (IMethodSymbol method in current.GetMembers().OfType<IMethodSymbol>())
                {
                    if (!method.IsStatic
                        && this.EmittedName(method, method.Name) == emittedName
                        && this.CanonicalReducedSignature(method, parameterOffset: 0)
                            == extensionSignature)
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private IEnumerable<IMethodSymbol> EnumerateKnownExtensionMethods(
            IMethodSymbol method)
        {
            string namespaceName = method.ContainingNamespace?.ToDisplayString()
                ?? string.Empty;
            string emittedName = this.EmittedName(method, method.Name);
            var seen = new HashSet<string>(StringComparer.Ordinal);

            foreach (INamedTypeSymbol type in method.ContainingNamespace.GetTypeMembers())
            {
                foreach (IMethodSymbol candidate in type.GetMembers().OfType<IMethodSymbol>())
                {
                    if (candidate.IsExtensionMethod
                        && this.EmittedName(candidate, candidate.Name) == emittedName
                        && seen.Add(ExtensionMethodIdentity(candidate)))
                    {
                        yield return candidate;
                    }
                }
            }

            foreach (CSharpCompilation compilation in this.KnownCompilations())
            {
                INamespaceSymbol package = FindNamespace(
                    compilation.Assembly.GlobalNamespace,
                    namespaceName);
                if (package == null)
                {
                    continue;
                }

                foreach (INamedTypeSymbol type in package.GetTypeMembers())
                {
                    foreach (IMethodSymbol candidate in type
                        .GetMembers()
                        .OfType<IMethodSymbol>())
                    {
                        if (candidate.IsExtensionMethod
                            && this.EmittedName(candidate, candidate.Name) == emittedName
                            && seen.Add(ExtensionMethodIdentity(candidate)))
                        {
                            yield return candidate;
                        }
                    }
                }
            }
        }

        private IEnumerable<CSharpCompilation> KnownCompilations() =>
            new[] { this.context.Compilation }
                .Concat(this.context.SiblingCompilations
                    ?? Array.Empty<CSharpCompilation>())
                .Concat(this.context.RepositoryCompilations
                    ?? Array.Empty<CSharpCompilation>())
                .Distinct();

        private static bool CompilationReferencesAssembly(
            CSharpCompilation compilation,
            IAssemblySymbol assembly) =>
            compilation != null
            && assembly != null
            && compilation.References.Any(reference =>
                compilation.GetAssemblyOrModuleSymbol(reference)
                    is IAssemblySymbol referenced
                && SameAssembly(referenced, assembly));

        private static bool SameAssembly(
            IAssemblySymbol left,
            IAssemblySymbol right) =>
            left != null
            && right != null
            && string.Equals(
                left.Identity.GetDisplayName(),
                right.Identity.GetDisplayName(),
                StringComparison.Ordinal);

        private static INamespaceSymbol FindNamespace(
            INamespaceSymbol root,
            string namespaceName)
        {
            INamespaceSymbol current = root;
            foreach (string segment in namespaceName.Split(
                '.',
                StringSplitOptions.RemoveEmptyEntries))
            {
                current = current?.GetNamespaceMembers()
                    .FirstOrDefault(candidate => candidate.Name == segment);
                if (current == null)
                {
                    return null;
                }
            }

            return current;
        }

        private string CanonicalExtensionSignature(IMethodSymbol method) =>
            this.CanonicalEmittedType(method.Parameters[0].Type, method)
            + "|"
            + this.CanonicalReducedSignature(method, parameterOffset: 1);

        private string CanonicalReducedSignature(
            IMethodSymbol method,
            int parameterOffset)
        {
            var parts = new List<string>
            {
                this.EmittedName(method, method.Name),
                method.TypeParameters.Length.ToString(CultureInfo.InvariantCulture),
            };
            for (int index = parameterOffset; index < method.Parameters.Length; index++)
            {
                IParameterSymbol parameter = method.Parameters[index];
                parts.Add(
                    parameter.RefKind.ToString()
                    + ":"
                    + (parameter.IsParams ? "params:" : string.Empty)
                    + this.CanonicalEmittedType(parameter.Type, method));
            }

            return string.Join("|", parts);
        }

        private string CanonicalEmittedType(
            ITypeSymbol type,
            IMethodSymbol method)
        {
            // Collision probing must not add imports or unsupported diagnostics
            // to the real translation (e.g. an Index-typed unrelated overload).
            var signatureContext = new TranslationContext(
                this.context.Compilation,
                this.context.SemanticModel,
                this.context.FilePath,
                this.context.SiblingCompilations,
                this.context.RepositoryCompilations);
            var signatureMapper = new CSharpTypeMapper(
                new AnonymousTypeRegistry(),
                this.nameAllocator);
            GTypeReference mapped = signatureMapper.Map(
                type,
                signatureContext,
                Location.None);
            string rendered = GSharpPrinter.RenderTypeReference(mapped)
                .Replace("?", string.Empty, StringComparison.Ordinal);
            foreach (ITypeParameterSymbol parameter in method.TypeParameters)
            {
                string name = Regex.Escape(this.EmittedName(parameter, parameter.Name));
                rendered = Regex.Replace(
                    rendered,
                    $@"(?<![\p{{L}}\p{{N}}_]){name}(?![\p{{L}}\p{{N}}_])",
                    "!" + parameter.Ordinal.ToString(CultureInfo.InvariantCulture));
            }

            return rendered;
        }

        private static string ExtensionMethodIdentity(IMethodSymbol method)
        {
            IMethodSymbol original = method?.ReducedFrom ?? method;
            string declarationId =
                DocumentationCommentId.CreateDeclarationId(original)
                ?? original.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            return original.ContainingAssembly?.Identity.GetDisplayName()
                + "|"
                + declarationId;
        }

        private bool IsStaticExtensionHelper(IMethodSymbol method)
        {
            if (this.ownedExtensions.IsStaticHelper(method))
            {
                return true;
            }

            IMethodSymbol original = method?.ReducedFrom ?? method;
            if (!RequiresOwnerScopedExtension(original) ||
                this.context.SiblingCompilations == null)
            {
                return false;
            }

            // Reproduce the owner-scoped declaration only for projects translated
            // in this run. Third-party metadata may also contain private nested
            // implementation types, but its imported extension remains external.
            string assemblyName = original.ContainingAssembly?.Identity.GetDisplayName();
            return assemblyName != null &&
                this.context.SiblingCompilations.Any(compilation =>
                    string.Equals(
                        compilation.Assembly.Identity.GetDisplayName(),
                        assemblyName,
                        StringComparison.Ordinal));
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
        private static bool IsCompoundAssignmentOperatorToken(SyntaxKind kind) =>
            kind == SyntaxKind.PlusEqualsToken
                || kind == SyntaxKind.MinusEqualsToken
                || kind == SyntaxKind.AsteriskEqualsToken
                || kind == SyntaxKind.SlashEqualsToken
                || kind == SyntaxKind.PercentEqualsToken
                || kind == SyntaxKind.AmpersandEqualsToken
                || kind == SyntaxKind.BarEqualsToken
                || kind == SyntaxKind.CaretEqualsToken
                || kind == SyntaxKind.LessThanLessThanEqualsToken
                || kind == SyntaxKind.GreaterThanGreaterThanEqualsToken
                || kind == SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;

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
        /// siblings, <c>op_AdditionAssignment</c> etc.) are NOT binary operators:
        /// they are instance, <c>void</c>-returning, single-parameter methods
        /// that mutate the receiver in place. gsc issue #2834 gives them a
        /// canonical G# spelling as an ordinary IN-BODY member —
        /// <c>public func operator +=(amount int32) { … }</c> — which round-trips
        /// to the same <c>specialname</c> instance <c>op_*Assignment</c> metadata
        /// Roslyn emits. They therefore keep their C# shape verbatim and are NOT
        /// lifted to a top-level receiver-clause sibling.
        /// </summary>
        private (GMember Member, bool IsStatic) TranslateOperator(OperatorDeclarationSyntax node)
        {
            string operatorToken = node.OperatorToken.Text;
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;

            if (IsCompoundAssignmentOperatorToken(node.OperatorToken.Kind()))
            {
                return (this.TranslateCompoundAssignmentOperator(node, operatorToken, symbol), false);
            }

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

        /// <summary>
        /// gsc issue #2834: translates a C# 14 instance compound-assignment
        /// operator (<c>public void operator +=(int amount)</c>) to the canonical
        /// G# in-body member <c>public func operator +=(amount int32) { … }</c>.
        /// Unlike a binary operator this keeps its C# shape exactly — instance,
        /// <c>void</c>, one parameter — and is not lifted to a receiver-clause
        /// sibling, so it round-trips to the same <c>specialname</c> instance
        /// <c>op_*Assignment</c> metadata Roslyn emits and consumes.
        /// </summary>
        private MethodDeclaration TranslateCompoundAssignmentOperator(
            OperatorDeclarationSyntax node,
            string operatorToken,
            IMethodSymbol symbol)
        {
            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            BlockStatement body = (node.Body != null || node.ExpressionBody != null)
                ? this.TranslateBody(node, $"operator '{operatorToken}'")
                : null;

            GStatement arrowBody = node.ExpressionBody != null ? TryFoldArrowBody(body) : null;
            if (arrowBody != null)
            {
                body = null;
            }

            return new MethodDeclaration(
                $"operator {operatorToken}",
                parameters: parameters,
                returnType: null,
                body: body,
                typeParameters: null,
                receiver: null,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: false,
                isOverride: false,
                isAsync: false,
                attributes: this.MapAttributes(node.AttributeLists),
                expressionBody: arrowBody);
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
        /// Issue #2665: preserves the CLR property ABI of an initialized static
        /// auto-property by lowering only its storage to an initialized backing
        /// field and keeping a computed property over that field.
        /// </summary>
        private bool TryTranslateStaticInitializedAutoProperty(
            PropertyDeclarationSyntax node,
            out FieldDeclaration field,
            out PropertyDeclaration property)
        {
            field = null;
            property = null;

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
            if (symbol == null)
            {
                return false;
            }

            GTypeReference type = this.typeMapper.Map(symbol.Type, this.context, node.GetLocation());

            GExpression initializer = this.CoerceConstantToUnsigned(
                node.Initializer.Value,
                this.TranslateNullSeamExpression(node.Initializer.Value));
            initializer = this.ForgiveNullableReferenceValue(
                node.Initializer.Value,
                initializer,
                symbol.Type,
                symbol);

            // Issue #1072: a non-nullable reference static auto-property whose
            // initializer is nullable (e.g. `GetAttribute<...>()?.Member`) is
            // rendered `T?` so the initializer assignment type-checks.
            type = this.PromoteIfInitializerNullable(type, symbol, node.Initializer.Value);

            BindingKind binding = hasSet ? BindingKind.Var : BindingKind.Let;
            string backingName = this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames: null);

            field = new FieldDeclaration(
                binding,
                backingName,
                type,
                initializer: initializer,
                visibility: Visibility.Private);

            var propertyAccessors = new List<PropertyAccessor>
            {
                new PropertyAccessor(
                    AccessorKind.Get,
                    new BlockStatement(new List<GStatement>
                    {
                        new ReturnStatement(new IdentifierExpression(backingName)),
                    }),
                    visibility: AccessorVisibility(accessors.First(a => a.IsKind(SyntaxKind.GetAccessorDeclaration)))),
            };
            if (hasSet)
            {
                propertyAccessors.Add(new PropertyAccessor(
                    AccessorKind.Set,
                    new BlockStatement(new List<GStatement>
                    {
                        new AssignmentStatement(
                            new IdentifierExpression(backingName),
                            new IdentifierExpression("value")),
                    }),
                    visibility: AccessorVisibility(accessors.First(a => a.IsKind(SyntaxKind.SetAccessorDeclaration)))));
            }

            property = new PropertyDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                type,
                propertyAccessors,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists));

            return true;

            Visibility AccessorVisibility(AccessorDeclarationSyntax accessor)
            {
                if (accessor.Modifiers.Count == 0)
                {
                    return Visibility.Default;
                }

                return MapVisibility(
                    this.context.GetDeclaredSymbol(accessor),
                    this.context,
                    accessor,
                    preserveStaticClassPrivate: true);
            }
        }

        private (GMember Member, bool IsStatic, GMember BackingField) TranslateProperty(
            PropertyDeclarationSyntax node, IReadOnlyCollection<string> primaryCtorParamNames = null)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;

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
            bool isRefReturnProperty = symbol != null && (symbol.ReturnsByRef || symbol.ReturnsByRefReadonly);

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
            if (symbol != null
                && isRefReturnProperty
                && (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface))
            {
                string abstractRefPropertyMessage =
                    $"ref-returning property '{node.Identifier.Text}' is abstract or declared on an interface, which " +
                    "has no G# form: G#'s by-ref property (issue #3879, ADR-0060 §14) is a concrete, computed-getter " +
                    "form only, because a slot names nothing to alias and an implementor could satisfy a `ref` " +
                    "requirement with a copy-returning property unchecked. A concrete `ref` property translates.";
                this.context.ReportUnsupported(node, abstractRefPropertyMessage);
                isRefReturnProperty = false;
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
            bool isExplicitInterfacePropertyImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            bool usesExplicitInterfacePropertyClause = isExplicitInterfacePropertyImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1;

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

            if (isExplicitInterfacePropertyImpl && !usesExplicitInterfacePropertyClause)
            {
                IPropertySymbol propertySurvivor = FindPriorCollidingSiblingProperty(symbol, node);
                if (propertySurvivor != null)
                {
                    string message =
                        $"explicit interface property implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfacePropertyName(symbol)}' " +
                        $"shares its name and signature with '{symbol.ContainingType.Name}.{FormatSiblingPropertyName(propertySurvivor)}'; " +
                        "one C# declaration targets multiple interface slots, while ADR-0149 carries one qualifier, so the " +
                        "two properties cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by name; if the surviving sibling's accessors differ from this dropped declaration's, any C# " +
                        "access through the interface-typed reference that previously reached this property now " +
                        "silently observes the surviving property instead (semantic loss, known gap, issue #1911 " +
                        "analogue). Separate explicit declarations with distinct qualifiers are fully supported (issue " +
                        "#2362, ADR-0149 explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.PropertyDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false, null);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a single-slot explicit property implementation, or null otherwise.
            GTypeReference explicitInterfacePropertyType = usesExplicitInterfacePropertyClause
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
                if (node.Initializer != null)
                {
                    type = this.PromoteIfInitializerNullable(type, symbol, node.Initializer.Value);
                }

                // Issue #3848 (family B): a generated `T[]` property written a
                // maybe-null ELEMENT renders `[]T?` — `Command.Arguments`,
                // written `[uri, range.Start]` with `uri` a `string?`.
                type = this.PromoteArrayElementIfGeneratedNullElement(type, symbol);
            }

            // Issue #1907: register a synthesized backing field BEFORE mapping the
            // accessor bodies below, so a `field` reference inside them (bound via
            // TranslateExpression's FieldExpressionSyntax case) resolves to it.
            string fieldKeywordBackingName = this.TryRegisterFieldKeywordBackingField(
                node, symbol, primaryCtorParamNames, out IFieldSymbol fieldKeywordBackingSymbol);
            if (fieldKeywordBackingName == null
                && !isStatic
                && node.Initializer != null
                && (!IsGetOnlyAutoProperty(node)
                    || symbol?.ContainingType?.IsRecord == true
                    || symbol?.IsOverride == true)
                && !IsNullOrSuppressedNull(node.Initializer.Value))
            {
                fieldKeywordBackingName = this.RegisterSynthesizedPropertyBackingField(
                    symbol,
                    primaryCtorParamNames);
            }

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
                    this.TranslateNullSeamExpression(node.Initializer.Value))
                : null;

            // Issue #3635: an initializer reading a member of a nullability-
            // OBLIVIOUS assembly (e.g. netstandard2.0's `bool.TrueString` or
            // `Array.Empty<T>()`) is imported by gsc as `T?` (#1354), while the
            // backing field itself stays the declared non-null `T`. Bridge with
            // `!!` exactly as the static auto-property and plain-field
            // initializer paths already do (GS0155/GS0156 otherwise). A backing
            // type already rendered nullable needs no bridge.
            if (backingInitializer != null && backingType is { IsNullable: false })
            {
                backingInitializer = this.ForgiveNullableReferenceValue(
                    node.Initializer.Value,
                    backingInitializer,
                    symbol?.Type,
                    symbol);
            }

            GMember backingField = fieldKeywordBackingName != null
                ? new FieldDeclaration(BindingKind.Var, fieldKeywordBackingName, backingType, initializer: backingInitializer, visibility: Visibility.Private)
                : null;

            List<PropertyAccessor> accessors = this.MapAccessors(node, fieldKeywordBackingName);

            // Issue #1278 / ADR-0131: a C# expression-bodied read-only property
            // (`string Name => expr;`) renders as the idiomatic G# property-level
            // arrow `prop Name T -> expr` when its get body folds to a single
            // inline statement.
            GStatement arrowBody = TryFoldComputedPropertyArrow(
                node.ExpressionBody, accessors, allowRefReturn: isRefReturnProperty);
            if (arrowBody != null)
            {
                accessors = new List<PropertyAccessor>();
            }

            bool isOverride = symbol != null && symbol.IsOverride;

            // An override get-only auto-property with an initializer
            // (`public override T P { get; } = init;`) cannot surface as
            // `get; init;` — the base declares only a getter, so the init
            // accessor has no override target and the property stops
            // implementing the abstract getter. Lower it to the synthesized
            // private backing field (seeded with the initializer above) plus a
            // computed arrow reading it.
            if (isOverride
                && !isStatic
                && node.Initializer != null
                && IsGetOnlyAutoProperty(node)
                && fieldKeywordBackingName != null)
            {
                arrowBody = new ReturnStatement(new IdentifierExpression(fieldKeywordBackingName));
                accessors = new List<PropertyAccessor>();
            }

            // Interface members are implicitly abstract; canonical G# interface
            // members carry no `open` modifier (ADR-0115 §B.6).
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // Issue #2362, ADR-0149: see the matching visibility comment in
            // TranslateMethod for the full rationale — a G# user-interface
            // explicit property implementation (explicit-interface clause + CLR
            // MethodImpl) keeps C#'s own `private`-equivalent visibility
            // (Roslyn reports `Private`, mapped straight through by
            // MapVisibility).
            Visibility explicitInterfacePropertyVisibility = isExplicitInterfacePropertyImpl && !usesExplicitInterfacePropertyClause
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var property = new PropertyDeclaration(
                this.EmittedName(symbol, node.Identifier.ValueText),
                type,
                accessors: accessors,
                visibility: explicitInterfacePropertyVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapPropertyAttributes(node),
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfacePropertyType,
                isRefReturn: isRefReturnProperty,
                isReadOnlyRefReturn: symbol?.ReturnsByRefReadonly == true);

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

            return this.RegisterSynthesizedPropertyBackingField(symbol, primaryCtorParamNames);
        }

        private string RegisterSynthesizedPropertyBackingField(
            IPropertySymbol symbol,
            IReadOnlyCollection<string> primaryCtorParamNames)
        {
            if (this.state.SynthesizedPropertyBackingFieldNames.TryGetValue(symbol, out string existing))
            {
                return existing;
            }

            string propName = symbol.Name;
            string baseName = "_" + (propName.Length > 0
                ? char.ToLowerInvariant(propName[0]) + propName.Substring(1)
                : propName);
            var taken = new HashSet<string>(
                symbol.ContainingType.GetMembers().Select(member => member.Name),
                StringComparer.Ordinal);
            if (primaryCtorParamNames != null)
            {
                taken.UnionWith(primaryCtorParamNames);
            }

            taken.UnionWith(this.state.SynthesizedPropertyBackingFieldNames.Values);

            string candidate = baseName;
            for (int suffix = 2; taken.Contains(candidate); suffix++)
            {
                candidate = baseName + suffix;
            }

            this.state.SynthesizedPropertyBackingFieldNames[symbol] = candidate;
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
        // Issue #3879: `allowRefReturn` is set by the property and indexer paths,
        // where the G# arrow form IS ref-aware — `prop P ref T -> lvalue`
        // desugars to `{ get { return ref lvalue } }` in gsc's parser, so the
        // fold preserves the aliasing. It stays false for the extension-property
        // path, which lowers to a `func` whose arrow form has no `-> ref lvalue`
        // spelling (the #3839 method rule).
        private static GStatement TryFoldComputedPropertyArrow(
            ArrowExpressionClauseSyntax csExpressionBody,
            List<PropertyAccessor> accessors,
            bool allowRefReturn = false)
        {
            if (csExpressionBody == null
                || accessors.Count != 1
                || accessors[0].Kind != AccessorKind.Get
                || accessors[0].Body == null)
            {
                return null;
            }

            return TryFoldArrowBody(accessors[0].Body, allowRefReturn);
        }
    }
}
