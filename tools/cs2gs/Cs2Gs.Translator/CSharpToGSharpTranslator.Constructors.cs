// <copyright file="CSharpToGSharpTranslator.Constructors.cs" company="GSharp">
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
        private (GMember Member, bool IsStatic) TranslateIndexer(IndexerDeclarationSyntax node)
        {
            // ADR-0118 / issue #944: a C# indexer (`public T this[int i] => ...`)
            // maps to the canonical G# indexer member (`prop this[i int32] T`).
            var symbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
            bool isStatic = symbol != null && symbol.IsStatic;

            // ADR-0149 (issue #944 follow-up): G# interfaces can now declare an
            // indexer MEMBER (the prior gsc limitation — DeclarationBinder
            // unconditionally rejecting `this[...]` inside an `interface` body
            // — has been removed), so an indexer implementing a G# USER
            // interface member now uses the exact same explicit-interface
            // qualifier clause (`prop (IFoo) this[...] T`) as an ordinary
            // property or method (issue #2010 / #2362 / ADR-0149), instead of
            // the #1911-style forced-public collision-drop fallback. That
            // fallback is now reserved for EXTERNAL/BCL interfaces only,
            // mirroring TranslatePropertyDeclaration exactly.
            bool isExplicitInterfaceIndexerImpl = symbol != null && symbol.ExplicitInterfaceImplementations.Length > 0;

            bool isUserInterfaceExplicitIndexerImpl = isExplicitInterfaceIndexerImpl &&
                symbol.ExplicitInterfaceImplementations.Length == 1 &&
                symbol.ExplicitInterfaceImplementations[0].ContainingType.Locations.Any(l => l.IsInSource);

            if (isExplicitInterfaceIndexerImpl && symbol.ExplicitInterfaceImplementations.Length > 1 &&
                symbol.ExplicitInterfaceImplementations.All(e => e.ContainingType.Locations.Any(l => l.IsInSource)))
            {
                string names = string.Join(", ", symbol.ExplicitInterfaceImplementations.Select(e => e.ContainingType.Name));
                string multiEntryMessage =
                    $"explicit interface indexer implementation '{FormatExplicitInterfacePropertyName(symbol)}' satisfies " +
                    $"more than one G# user interface member in one C# declaration ({names}), likely via interface " +
                    "inheritance (a base interface re-declaring the same indexer). The ADR-0149 explicit-interface-clause " +
                    "scheme only wires a single interface slot per indexer, so this falls back to " +
                    "the #1911-style named/forced-public path instead of a clause — the indexer keeps its plain \"this[]\" " +
                    "form and every interface's slot is satisfied via ordinary implicit signature dispatch (known gap: " +
                    "the indexer becomes publicly callable through any interface reference, unlike real C# explicit-impl " +
                    "semantics).";
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.IndexerDeclaration), multiEntryMessage, node.GetLocation(), TranslationSeverity.Info));
            }

            if (isExplicitInterfaceIndexerImpl && !isUserInterfaceExplicitIndexerImpl)
            {
                IPropertySymbol indexerSurvivor = FindPriorCollidingSiblingProperty(symbol, node);
                if (indexerSurvivor != null)
                {
                    string message =
                        $"explicit interface indexer implementation '{symbol.ContainingType.Name}.{FormatExplicitInterfacePropertyName(symbol)}' " +
                        $"shares its parameter shape with '{symbol.ContainingType.Name}.{FormatSiblingPropertyName(indexerSurvivor)}'; " +
                        "G# has no explicit-interface-implementation surface for EXTERNAL interfaces (ADR-0091), so the " +
                        "two C# indexers cannot both be emitted (would be an exact-signature duplicate, GS0102). This " +
                        "declaration is dropped in favor of the surviving sibling, which already satisfies the interface " +
                        "by parameter shape; if the surviving sibling's accessors differ from this dropped declaration's, " +
                        "any C# access through the interface-typed reference that previously reached this indexer now " +
                        "silently observes the surviving indexer instead (semantic loss, known gap, issue #1911 " +
                        "analogue). This diagnostic covers only EXTERNAL/BCL interfaces — a same-signature collision " +
                        "between two G# user-interface explicit indexer implementations is fully supported (issue " +
                        "#944 follow-up, ADR-0149 explicit-interface clause).";
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.IndexerDeclaration), message, node.GetLocation(), TranslationSeverity.Unsupported));

                    return (null, false);
                }
            }

            // ADR-0149: the resolved explicit-interface qualifier clause type
            // for a G# user-interface explicit indexer implementation, or null
            // otherwise (ordinary indexer, or external-interface explicit
            // implementation, which keeps the pre-#2010 name-based dispatch).
            GTypeReference explicitInterfaceIndexerType = isUserInterfaceExplicitIndexerImpl
                ? this.typeMapper.Map(symbol.ExplicitInterfaceImplementations[0].ContainingType, this.context, node.GetLocation())
                : null;

            GTypeReference type = symbol != null
                ? this.typeMapper.Map(symbol.Type, this.context, node.GetLocation())
                : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);

            // Issue #2157 / #1354: an oblivious indexer whose getter yields a
            // nullable value (`?.` / `??` / `return null`), or one null-checked
            // in its declaring type, is rendered `T?` so the getter body
            // type-checks.
            if (symbol != null)
            {
                type = this.PromoteIfUsedAsNullable(type, symbol);
            }

            List<Parameter> indexParameters = symbol != null
                ? symbol.Parameters.Select(p => this.MapParameter(p, node)).ToList()
                : this.MapParameterList(node.ParameterList);

            List<PropertyAccessor> accessors = this.MapAccessors(node, "indexer 'this[]'");

            // Issue #1278 / ADR-0131: a C# expression-bodied indexer
            // (`public T this[int i] => expr;`) renders as the idiomatic G#
            // indexer-level arrow `prop this[i T] U -> expr`.
            GStatement arrowBody = TryFoldComputedPropertyArrow(node.ExpressionBody, accessors);
            if (arrowBody != null)
            {
                accessors = new List<PropertyAccessor>();
            }

            bool isOverride = symbol != null && symbol.IsOverride && !OverridesExternalBaseProperty(symbol);
            bool isOpen = this.IsMemberEmittedOpen(symbol, isOverride);

            // ADR-0149: see the matching visibility comment in
            // TranslatePropertyDeclaration for the full rationale — a G#
            // user-interface explicit indexer implementation (explicit-
            // interface clause + CLR MethodImpl) keeps C#'s own
            // `private`-equivalent visibility (Roslyn reports `Private`,
            // mapped straight through by MapVisibility); an EXTERNAL/BCL
            // interface explicit indexer implementation still relies on
            // name+parameter-shape dispatch and must stay forced-public
            // (`Visibility.Default`) or ilverify would reject the missing
            // interface method.
            Visibility indexerVisibility = isExplicitInterfaceIndexerImpl && !isUserInterfaceExplicitIndexerImpl
                ? Visibility.Default
                : MapVisibility(symbol, this.context, node);

            var property = new PropertyDeclaration(
                "this",
                type,
                accessors: accessors,
                visibility: indexerVisibility,
                isOpen: isOpen,
                isOverride: isOverride,
                attributes: this.MapAttributes(node.AttributeLists),
                indexerParameters: indexParameters,
                expressionBody: arrowBody,
                explicitInterfaceType: explicitInterfaceIndexerType);

            return (property, isStatic);
        }

        private List<PropertyAccessor> MapAccessors(BasePropertyDeclarationSyntax node, string displayName, string fieldKeywordBackingName = null)
        {
            // An expression-bodied property (=> expr) is a get-only computed
            // property; its body is deferred to step 7 (ADR-0115 §B.11).
            ArrowExpressionClauseSyntax expressionBody = node switch
            {
                PropertyDeclarationSyntax p => p.ExpressionBody,
                IndexerDeclarationSyntax i => i.ExpressionBody,
                _ => null,
            };

            if (expressionBody != null)
            {
                return new List<PropertyAccessor>
                {
                    new PropertyAccessor(
                        AccessorKind.Get,
                        this.TranslateBody(node, $"{displayName} getter")),
                };
            }

            if (node.AccessorList == null)
            {
                return new List<PropertyAccessor>();
            }

            IReadOnlyList<AccessorDeclarationSyntax> declared = node.AccessorList.Accessors;

            // Issue #1741: an accessor-level accessibility modifier (`{ get; private
            // set; }`) narrows just that accessor; G# has no per-accessor
            // accessibility, so it would silently widen back to the property's own
            // accessibility. Diagnose the loss instead of translating it silently.
            foreach (AccessorDeclarationSyntax accessor in declared)
            {
                SyntaxToken accessibilityModifier = accessor.Modifiers.FirstOrDefault(m =>
                    m.IsKind(SyntaxKind.PrivateKeyword) ||
                    m.IsKind(SyntaxKind.ProtectedKeyword) ||
                    m.IsKind(SyntaxKind.InternalKeyword));
                if (accessibilityModifier.IsKind(SyntaxKind.None))
                {
                    continue;
                }

                string accessorMods = string.Join(" ", accessor.Modifiers.Select(m => m.ValueText));
                this.context.Report(new TranslationDiagnostic(
                    accessor.Kind().ToString(),
                    $"{displayName} accessor '{accessorMods} {accessor.Keyword.ValueText}' has narrower accessibility than the property; G# has no per-accessor accessibility, so it is widened to the property's own accessibility (ADR-0115 §B.11).",
                    accessor.GetLocation(),
                    TranslationSeverity.Warning));
            }

            bool anyBodied = declared.Any(a => a.Body != null || a.ExpressionBody != null);
            bool hasSet = declared.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));
            bool hasGet = declared.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            bool hasInit = declared.Any(a => a.IsKind(SyntaxKind.InitAccessorDeclaration));

            // A read-write auto-property (all accessors body-less, has get + set)
            // maps to the canonical auto form `prop Name T` (ADR-0115 §B.11). An
            // init-only auto-property (get + init) keeps its explicit accessors so
            // the init-only semantics are preserved (issue #946).
            if (!anyBodied && hasGet && hasSet)
            {
                return new List<PropertyAccessor>();
            }

            // OD-T1: a C# get-only auto-property (`{ get; }`, body-less, no set/init)
            // is settable in the declaring type's constructor. G# `{ get; }` alone
            // is read-only (assigning it gives GS0127), so emit it as an init-only
            // auto-property `{ get; init; }`. Interface/abstract contract members
            // carry no backing field and remain read-only contracts.
            if (!anyBodied && hasGet && !hasSet && !hasInit)
            {
                var propSymbol = this.context.GetDeclaredSymbol(node) as IPropertySymbol;
                bool isContract = propSymbol != null &&
                    (propSymbol.IsAbstract ||
                        propSymbol.ContainingType?.TypeKind == TypeKind.Interface);
                if (!isContract)
                {
                    return new List<PropertyAccessor>
                    {
                        new PropertyAccessor(AccessorKind.Get, null),
                        new PropertyAccessor(AccessorKind.Init, null),
                    };
                }
            }

            var accessors = new List<PropertyAccessor>();
            foreach (AccessorDeclarationSyntax accessor in declared)
            {
                AccessorKind kind;
                if (accessor.IsKind(SyntaxKind.GetAccessorDeclaration))
                {
                    kind = AccessorKind.Get;
                }
                else if (accessor.IsKind(SyntaxKind.InitAccessorDeclaration))
                {
                    // Issue #946: G# now supports a first-class 'init' accessor.
                    kind = AccessorKind.Init;
                }
                else
                {
                    kind = AccessorKind.Set;
                }

                bool bodied = accessor.Body != null || accessor.ExpressionBody != null;
                BlockStatement body = bodied
                    ? this.TranslateBody(
                        accessor,
                        $"{displayName} {kind.ToString().ToLowerInvariant()}ter")
                    : null;

                // Issue #1907: a bodyless (auto) accessor sibling to a `field`-
                // keyword accessor on the same property (e.g. `set;` beside
                // `get => field ??= ...;`) implicitly reads/writes that SAME
                // compiler-synthesized backing field — synthesize the equivalent
                // explicit body against the field just registered for this
                // property (ADR-0051 §2 computed-property shape).
                if (!bodied && fieldKeywordBackingName != null)
                {
                    body = kind == AccessorKind.Get
                        ? new BlockStatement(new List<GStatement>
                        {
                            new ReturnStatement(new IdentifierExpression(fieldKeywordBackingName)),
                        })
                        : new BlockStatement(new List<GStatement>
                        {
                            new AssignmentStatement(
                                new IdentifierExpression(fieldKeywordBackingName),
                                new IdentifierExpression("value")),
                        });
                }

                // Issue #1278 / ADR-0131: a C# expression-bodied accessor
                // (`get => e` / `set => e`) renders as the idiomatic G# arrow
                // accessor `get -> e` / `set -> e` when its body folds to a
                // single inline statement.
                GStatement arrowBody = accessor.ExpressionBody != null ? TryFoldArrowBody(body) : null;
                if (arrowBody != null)
                {
                    body = null;
                }

                accessors.Add(new PropertyAccessor(kind, body, expressionBody: arrowBody));
            }

            return accessors;
        }

        private GMember TranslateConstructor(
            ConstructorDeclarationSyntax node,
            IReadOnlyList<(string Name, GExpression Value)> propertyCtorInits)
        {
            var symbol = this.context.GetDeclaredSymbol(node) as IMethodSymbol;
            if (node.Modifiers.Any(SyntaxKind.StaticKeyword))
            {
                // A `static` constructor has no G# form. When it only initializes
                // static fields with simple `Field = value;` assignments, those are
                // folded into the corresponding `shared { }` field initializers
                // (see CollectStaticFieldInitializers / TranslateField) and the
                // constructor is dropped. Anything more complex is unsupported.
                if (this.IsFoldableStaticConstructor(node, symbol?.ContainingType))
                {
                    return null;
                }

                // ADR-0140 / ADR-0115 §B.11: a non-foldable static constructor
                // maps to a G# `init { ... }` static-initializer block inside the
                // type's `shared { }` block. Simple static-field initializers are
                // hoisted onto their field declarations separately (see
                // CollectStaticFieldInitializers); the remaining ctor body is
                // translated as-is here.
                BlockStatement staticInitBody = this.TranslateBody(node, "static initializer");
                return new StaticInitializerBlock(staticInitBody);
            }

            List<Parameter> parameters = this.MapParameters(symbol, node.ParameterList, skipFirst: false);

            List<GExpression> baseArguments = null;
            bool isConvenience = false;
            if (node.Initializer != null)
            {
                if (node.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.BaseKeyword))
                {
                    // A `: base(args)` chain maps to the canonical G# explicit-base
                    // form `init(params) : base(args) { ... }` (sample
                    // ExplicitConstructor.gs; ADR-0115 §B.13). This is how a custom
                    // exception forwards its message to System.Exception's ctor.
                    baseArguments = this.TranslateNullSeamArguments(
                        node.Initializer.ArgumentList.Arguments, symbol);
                }
                else
                {
                    // `: this(args)` (constructor delegation) maps to a G#
                    // `convenience init(params) { init(args); ... }`: the delegated
                    // `init(args)` call is the first body statement (ADR-0065).
                    isConvenience = true;
                }
            }

            BlockStatement body = this.TranslateBody(node, $"constructor on '{node.Identifier.Text}'");

            if (isConvenience)
            {
                var delegated = new ExpressionStatement(new InvocationExpression(
                    new IdentifierExpression("init"),
                    this.TranslateNullSeamArguments(node.Initializer.ArgumentList.Arguments, symbol)));
                var statements = new List<GStatement> { delegated };
                statements.AddRange(body.Statements);
                body = new BlockStatement(statements);
            }
            else if (propertyCtorInits != null && propertyCtorInits.Count > 0)
            {
                // OD-T1: move get-only auto-property inline initializers into the
                // designated constructor body (G# has no property member
                // initializer). Prepend them so the property is initialized before
                // the original constructor body runs, matching C# member-initializer
                // ordering. Delegating (`: this(...)`) constructors are skipped — the
                // designated target already runs the initializers.
                var statements = propertyCtorInits
                    .Select(p => (GStatement)new AssignmentStatement(new IdentifierExpression(p.Name), p.Value))
                    .ToList();
                statements.AddRange(body.Statements);
                body = new BlockStatement(statements);
            }

            return new ConstructorDeclaration(
                parameters,
                body,
                baseArguments: baseArguments,
                visibility: MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists),
                isConvenience: isConvenience);
        }

        /// <summary>
        /// Collects the static-field initializers of a foldable <c>static</c>
        /// constructor so they can be re-attached to the corresponding fields
        /// (G# has no static-constructor form; ADR-0115 §B.11).
        /// </summary>
        private void CollectStaticFieldInitializers(IReadOnlyList<MemberDeclarationSyntax> members, INamedTypeSymbol typeSymbol)
        {
            foreach (MemberDeclarationSyntax member in members)
            {
                if (member is not ConstructorDeclarationSyntax ctor ||
                    !ctor.Modifiers.Any(SyntaxKind.StaticKeyword) ||
                    ctor.Body == null)
                {
                    continue;
                }

                // Issue #1910: a merged-in static constructor from another
                // partial part/file lives in a different `SyntaxTree`.
                using IDisposable modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree);

                if (!this.IsFoldableStaticConstructor(ctor, typeSymbol))
                {
                    continue;
                }

                foreach (StatementSyntax statement in ctor.Body.Statements)
                {
                    if (statement is ExpressionStatementSyntax expressionStatement &&
                        expressionStatement.Expression is AssignmentExpressionSyntax assignment &&
                        assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) &&
                        this.context.GetSymbolInfo(assignment.Left).Symbol is IFieldSymbol field)
                    {
                        this.state.StaticFieldInitializers[field] = this.TranslateExpression(assignment.Right);
                    }
                }
            }
        }

        /// <summary>
        /// Issue #1729: a static constructor folds cleanly only when every
        /// statement is a simple <c>Field = expr;</c> assignment where (mode 2)
        /// the assigned field belongs to the type declaring the constructor — an
        /// assignment to another type's static field would be silently dropped,
        /// since the folded entry is keyed by that other field and never consumed
        /// — and (mode 3) the RHS does not depend on the type's own static state,
        /// since hoisting it to the field's declaration position could change
        /// C#'s field-initializers-then-cctor evaluation order. Anything else is
        /// reported as unsupported instead of silently folded.
        /// </summary>
        private bool IsFoldableStaticConstructor(ConstructorDeclarationSyntax node, INamedTypeSymbol typeSymbol)
        {
            if (node.Body == null)
            {
                return node.ExpressionBody == null;
            }

            if (typeSymbol == null)
            {
                return false;
            }

            foreach (StatementSyntax statement in node.Body.Statements)
            {
                if (statement is not ExpressionStatementSyntax expressionStatement ||
                    expressionStatement.Expression is not AssignmentExpressionSyntax assignment ||
                    !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression) ||
                    this.context.GetSymbolInfo(assignment.Left).Symbol is not IFieldSymbol { IsStatic: true } field ||
                    !SymbolEqualityComparer.Default.Equals(field.ContainingType, typeSymbol) ||
                    this.ReferencesStaticMemberOfType(assignment.Right, typeSymbol))
                {
                    return false;
                }
            }

            return true;
        }

        private (GTypeReference BaseType, List<GTypeReference> Interfaces) MapBaseClause(
            INamedTypeSymbol symbol,
            SyntaxNode node,
            TypeDeclarationKind kind)
        {
            var interfaces = new List<GTypeReference>();
            GTypeReference baseType = null;

            if (symbol == null)
            {
                return (null, interfaces);
            }

            Location location = node.GetLocation();
            INamedTypeSymbol csBase = symbol.BaseType;
            if (csBase != null &&
                csBase.SpecialType != SpecialType.System_Object &&
                csBase.SpecialType != SpecialType.System_ValueType &&
                csBase.TypeKind == TypeKind.Class &&
                csBase.SpecialType != SpecialType.System_Enum)
            {
                baseType = this.typeMapper.Map(csBase, this.context, location);
            }

            // A `data class` / `data struct` (C# record / record struct) synthesizes
            // structural equality in G#, exactly as the C# record auto-implements
            // `IEquatable<Self>`. Re-stating the synthesized `IEquatable[Self]` base
            // clause is redundant for a `data` type (equality comes from the `data`
            // modifier) and would be unimplemented on a fieldless record mapped to a
            // plain `class` (no synthesized `Equals`), so it is dropped here.
            // (Naming the enclosing type as a base-clause type ARGUMENT is itself
            // legal since issue #949 — `open class Shape : IEquatable[Shape]` now
            // compiles; the drop is a semantic redundancy filter, not a syntax
            // limitation.) See ADR-0115 §B.4.
            bool isRecord = symbol.IsRecord;
            foreach (INamedTypeSymbol iface in symbol.Interfaces)
            {
                if (isRecord && IsIEquatableOf(iface, symbol))
                {
                    continue;
                }

                // Interface inheritance is supported by the G# parser since
                // issue #1006 (`interface B : A, C { ... }`); the printer emits
                // base interfaces via the same base-clause path as a class, so
                // a base interface is added to the interface's base list.
                interfaces.Add(this.typeMapper.Map(iface, this.context, location));
            }

            return (baseType, interfaces);
        }

        /// <summary>
        /// Issue #1909: maps a C# <c>: Base(args)</c> base-class initializer
        /// (Roslyn's <see cref="PrimaryConstructorBaseTypeSyntax"/> — the only base-list
        /// entry kind that carries an argument list; an implemented interface is
        /// always a plain <see cref="SimpleBaseTypeSyntax"/>) onto the G# primary
        /// constructor's own base-call syntax <c>class Derived(...) : Base(args)</c>
        /// (Parser.cs `baseCtorOpenParen` / `BaseConstructorArguments`). Returns
        /// <see langword="null"/> when the base clause has no explicit call — the
        /// G# emitter then synthesizes the implicit parameterless base chain
        /// (ADR-0065 §5), matching a C# base with no arguments (or no base at all).
        /// </summary>
        private List<GExpression> MapPrimaryConstructorBaseArguments(TypeDeclarationSyntax node, GTypeReference baseType)
        {
            if (baseType == null || node.BaseList == null)
            {
                return null;
            }

            foreach (BaseTypeSyntax baseTypeSyntax in node.BaseList.Types)
            {
                if (baseTypeSyntax is PrimaryConstructorBaseTypeSyntax primaryBase)
                {
                    return primaryBase.ArgumentList.Arguments
                        .Select(a => this.TranslateExpression(a.Expression))
                        .ToList();
                }
            }

            return null;
        }

        private static bool IsIEquatableOf(INamedTypeSymbol iface, INamedTypeSymbol self)
        {
            return iface.IsGenericType &&
                iface.Name == "IEquatable" &&
                iface.ContainingNamespace?.ToDisplayString() == "System" &&
                iface.TypeArguments.Length == 1 &&
                SymbolEqualityComparer.Default.Equals(iface.TypeArguments[0], self);
        }

        private List<TypeParameter> MapTypeParameters(INamedTypeSymbol symbol)
        {
            if (symbol == null || symbol.TypeParameters.Length == 0)
            {
                return new List<TypeParameter>();
            }

            return symbol.TypeParameters.Select(this.MapTypeParameter).ToList();
        }

        private List<TypeParameter> MapMethodTypeParameters(IMethodSymbol symbol)
        {
            if (symbol == null || symbol.TypeParameters.Length == 0)
            {
                return new List<TypeParameter>();
            }

            return symbol.TypeParameters.Select(this.MapTypeParameter).ToList();
        }

        private TypeParameter MapTypeParameter(ITypeParameterSymbol tp)
        {
            var flags = new List<string>();
            if (tp.HasReferenceTypeConstraint)
            {
                flags.Add("class");
            }

            if (tp.HasUnmanagedTypeConstraint)
            {
                // Issue #1336: C# `where T : unmanaged` maps to the G# `unmanaged`
                // flag constraint. It subsumes `struct` (gsc reports a conflict if
                // both are spelled), so the value-type flag is intentionally omitted.
                flags.Add("unmanaged");
            }
            else if (tp.HasValueTypeConstraint)
            {
                flags.Add("struct");
            }

            if (tp.HasConstructorConstraint)
            {
                flags.Add("init()");
            }

            // C# `where T : notnull` has no precise G# constraint keyword; it is
            // dropped (the closest forms `comparable`/`any` change semantics), and
            // the loss is recorded (ADR-0115 §B.7 gap).
            if (tp.HasNotNullConstraint)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.TypeParameterConstraintClause),
                    $"type parameter '{tp.Name}' has a 'notnull' constraint; G# has no equivalent constraint keyword, so it is dropped (ADR-0115 §B.7 gap).",
                    tp.Locations.FirstOrDefault(),
                    TranslationSeverity.Info));
            }

            string legacy = null;
            if (tp.ConstraintTypes.Length > 0)
            {
                ITypeSymbol primary = tp.ConstraintTypes[0];

                // Issue #943: a constructed generic-interface constraint
                // (`where T : IComparable<T>`) now has a canonical G# form —
                // `[T IComparable[T]]` — which parses, binds, emits verifiable
                // IL, and is enforced. Render the constraint type (including its
                // type arguments, e.g. the self-referential `T`) into the legacy
                // constraint slot via the type mapper + printer.
                if (primary is INamedTypeSymbol { IsGenericType: true })
                {
                    GTypeReference constraintRef = this.typeMapper.Map(primary, this.context, tp.Locations.FirstOrDefault());
                    legacy = GSharpPrinter.RenderTypeReference(constraintRef);
                }
                else
                {
                    legacy = primary.Name;
                }

                if (tp.ConstraintTypes.Length > 1)
                {
                    this.context.Report(new TranslationDiagnostic(
                        nameof(SyntaxKind.TypeParameterConstraintClause),
                        $"type parameter '{tp.Name}' has multiple constraint types; only the first ('{legacy}') is carried into the G# legacy-constraint slot (ADR-0115 §B.7).",
                        tp.Locations.FirstOrDefault(),
                        TranslationSeverity.Info));
                }
            }

            Variance variance = tp.Variance switch
            {
                VarianceKind.Out => Variance.Out,
                VarianceKind.In => Variance.In,
                _ => Variance.None,
            };

            return new TypeParameter(SanitizeIdentifier(tp.Name), legacy, flags, variance);
        }

        // Issue #1909: `TypeDeclarationSyntax.ParameterList` carries a primary
        // constructor's parameter list for EVERY declaration kind that supports one
        // — `record`/`record struct` (their positional parameter list, in C# 9+)
        // as well as a plain `class`/`struct` (C# 12 primary constructors). All map
        // the same way onto a G# primary constructor (ADR-0065 §5), so the check no
        // longer needs to special-case `RecordDeclarationSyntax`.
        private IReadOnlyList<Parameter> MapPrimaryConstructor(TypeDeclarationSyntax node)
        {
            if (node.ParameterList != null)
            {
                return this.MapParameterList(node.ParameterList);
            }

            return null;
        }

        private List<Parameter> MapParameters(IMethodSymbol symbol, ParameterListSyntax syntax, bool skipFirst)
        {
            if (symbol != null)
            {
                IEnumerable<IParameterSymbol> source = symbol.Parameters;
                if (skipFirst)
                {
                    source = source.Skip(1);
                }

                // Fall back to the parameter LIST's syntax as the diagnostic anchor
                // for each parameter symbol here: when `symbol` overrides/implements
                // a member from a REFERENCED assembly, its `IParameterSymbol`s have
                // no `DeclaringSyntaxReferences` of their own (see
                // <see cref="MapConstantDefault"/> remarks).
                return source.Select(p => this.MapParameter(p, syntax)).ToList();
            }

            return syntax == null ? new List<Parameter>() : this.MapParameterList(syntax);
        }

        private List<Parameter> MapParameterList(BaseParameterListSyntax syntax)
        {
            var parameters = new List<Parameter>();
            foreach (ParameterSyntax parameter in syntax.Parameters)
            {
                if (this.context.GetDeclaredSymbol(parameter) is IParameterSymbol symbol)
                {
                    parameters.Add(this.MapParameter(symbol, parameter));
                }
            }

            return parameters;
        }

        private Parameter MapParameter(IParameterSymbol symbol, SyntaxNode fallbackNode)
        {
            string refKind = symbol.RefKind switch
            {
                RefKind.Ref => "ref",
                RefKind.Out => "out",
                RefKind.In => "in",
                _ => null,
            };

            // gsc's own variadic parameter (`...T`, DeclarationBinder.cs) is always
            // an array/slice — it has no params-COLLECTION concept (C#13). A C#
            // `params List<int>`/`params IEnumerable<T>` parameter therefore maps
            // to an ordinary (non-variadic) G# parameter of the FULL collection
            // type; `variadic` here is only ever true for the genuine `params T[]`
            // shape, which gsc's variadic slice already models 1:1. The
            // corresponding expanded call site (`Total(1, 2, 3)`) is lowered at the
            // CALL, not the declaration — see <see cref="TranslateParamsCollectionArguments"/>.
            bool variadic = symbol.IsParams && symbol.Type is IArrayTypeSymbol;
            ITypeSymbol parameterType = symbol.Type;
            if (variadic && parameterType is IArrayTypeSymbol arrayType)
            {
                parameterType = arrayType.ElementType;
            }

            if (symbol.IsParams && !variadic && !IsSupportedParamsCollectionType(parameterType))
            {
                // The call-site expansion (TranslateCallArguments) only knows how
                // to lower an expanded 'params' call into a List[T]{...} literal
                // for the allowlisted collection shapes below. A callee declared
                // with e.g. `params ReadOnlySpan<T>`/`params HashSet<T>` would
                // otherwise translate "successfully" here while every call site
                // gaps — a half-translated callee with no working caller. Gap the
                // declaration too, so the two sides stay consistent.
                this.context.ReportUnsupported(
                    fallbackNode,
                    $"params collection of type '{parameterType}' has no gsc construction form.");
            }

            GTypeReference type = this.typeMapper.Map(parameterType, this.context, symbol.Locations.FirstOrDefault());

            // Issue #1072: a non-nullable reference/array parameter that is
            // null-checked or null-assigned in the method body is really nullable;
            // render it `T?` so the `== nil` guard type-checks (variadic params are
            // never null-compared as a whole, so they are excluded).
            if (!variadic)
            {
                type = this.PromoteIfUsedAsNullable(type, symbol);
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
            if (!variadic)
            {
                type = this.PromoteDelegateParameterInvokedWithNull(type, symbol);
            }

            GExpression defaultValue = this.BuildOptionalParameterDefault(symbol, type, fallbackNode);

            // Issue #1913: a parameter's own attributes (e.g. `[Note] int x`) live on
            // its `ParameterSyntax`, not on `fallbackNode` (which can be the whole
            // parameter LIST when `symbol` came from `MapParameters`). Resolve the
            // parameter's declaring syntax directly from the symbol so both call
            // paths route through the same `MapAttributes` helper every other
            // declaration kind already uses — otherwise the attribute is silently
            // dropped with no diagnostic.
            ParameterSyntax parameterSyntax = symbol.DeclaringSyntaxReferences
                .Select(syntaxReference => syntaxReference.GetSyntax())
                .OfType<ParameterSyntax>()
                .FirstOrDefault();
            List<AttributeUse> attributes = parameterSyntax != null
                ? this.MapAttributes(parameterSyntax.AttributeLists)
                : null;

            return new Parameter(SanitizeIdentifier(symbol.Name), type, variadic, refKind, defaultValue, attributes);
        }

        /// <summary>
        /// Computes the G# default-value expression for an optional C# parameter,
        /// or <c>null</c> when the parameter is required or its default cannot be
        /// represented as a simple literal. An optional parameter whose default is
        /// the zero value (<c>= default</c>, <c>= default(T)</c>, or <c>= null</c>)
        /// must never be dropped — doing so makes the parameter required and triggers
        /// GS0144 at call sites. A non-nullable value type emits <c>default(T)</c>
        /// (gsc rejects a bare <c>default</c> with GS0265); a reference or nullable
        /// value type emits <c>nil</c>.
        /// </summary>
        /// <remarks>
        /// Issue #1731 N1: a C# optional-parameter default must itself be a
        /// compile-time constant, so this method (and <see cref="MapConstantDefault"/>)
        /// only ever reads <c>symbol.ExplicitDefaultValue</c> — it never calls
        /// <c>TranslateExpression</c>/<c>TranslatePatternTest</c>/
        /// <c>TranslateRangeSlice</c> on the source syntax at all. A non-constant
        /// default (which could theoretically embed an `is`-pattern or a
        /// range-slice, except neither of those is itself a constant expression
        /// either) falls through to the "not a simple literal" diagnostic below
        /// and is omitted, never translated. So `SpillOperand`'s no-seam
        /// fallback can never be reached from here.
        /// </remarks>
        private GExpression BuildOptionalParameterDefault(IParameterSymbol symbol, GTypeReference type, SyntaxNode fallbackNode)
        {
            if (!symbol.HasExplicitDefaultValue)
            {
                return null;
            }

            GExpression defaultValue = this.MapConstantDefault(symbol, fallbackNode);
            if (defaultValue != null)
            {
                return defaultValue;
            }

            if (symbol.ExplicitDefaultValue == null)
            {
                bool nullableValueType =
                    symbol.Type.OriginalDefinition?.SpecialType == SpecialType.System_Nullable_T;
                bool nonNullableValueType = symbol.Type.IsValueType
                    && !nullableValueType
                    && symbol.Type.NullableAnnotation != NullableAnnotation.Annotated;
                return nonNullableValueType
                    ? new DefaultValueExpression(type)
                    : new IdentifierExpression("nil");
            }

            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.EqualsValueClause),
                $"parameter '{symbol.Name}' has a default value that is not a simple literal; the default is omitted for now (deferred to step 7).",
                symbol.Locations.FirstOrDefault(),
                TranslationSeverity.Info));
            return null;
        }

        private GTypeReference MapReturnType(IMethodSymbol symbol, MethodDeclarationSyntax node)
        {
            if (symbol != null)
            {
                if (symbol.ReturnsVoid)
                {
                    return null;
                }

                ITypeSymbol returnType = symbol.ReturnType;

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
                if (IsIteratorBody(node) &&
                    returnType is INamedTypeSymbol { IsGenericType: true } enumerable &&
                    enumerable.Name is "IEnumerable")
                {
                    GTypeReference element = this.typeMapper.Map(
                        enumerable.TypeArguments[0], this.context, node.ReturnType.GetLocation());
                    return new NamedTypeReference("sequence", new[] { element });
                }

                // A G# `async func` declares the UNWRAPPED result type; the `async`
                // modifier synthesizes the `Task`/`Task<T>` envelope (samples
                // AsyncTask.gs, AsyncValueReturns.gs). C# `async Task` → no return
                // type; `async Task<int>` → `int32` (ADR-0115 §B async).
                if (symbol.IsAsync &&
                    returnType is INamedTypeSymbol { Name: "Task" } task &&
                    task.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks")
                {
                    if (!task.IsGenericType)
                    {
                        return null;
                    }

                    // Issue #2421: an `async Task<T>` return is still a
                    // declaration sink for T like any other method return —
                    // the unwrap above must not skip the SAME tuple/scalar
                    // promotion the synchronous path below applies, keyed off
                    // the AWAITED type T (see PromoteAwaitedReturnIfTainted).
                    ITypeSymbol awaitedType = task.TypeArguments[0];
                    GTypeReference awaitedMapped = this.typeMapper.Map(
                        awaitedType, this.context, node.ReturnType.GetLocation());
                    awaitedMapped = this.PromoteTupleReturnIfTainted(awaitedMapped, awaitedType, node);
                    return this.PromoteAwaitedReturnIfTainted(awaitedMapped, awaitedType, symbol);
                }

                // Issue #1900: `symbol.ReturnType` is already the pointee type T
                // for a `ref`-returning method (Roslyn strips the `ref`); the
                // `ref` modifier itself is reinstated at the MethodDeclaration
                // (IsRefReturn) by the caller, mapping to G#'s native
                // ref-return (`func F(...) ref T`, issue #490/ADR-0060).
                GTypeReference mapped = this.typeMapper.Map(returnType, this.context, node.ReturnType.GetLocation());

                // Issue #914 (oblivious sink): a TUPLE return whose returned tuple
                // expression carries a promoted-nullable element (e.g. `return
                // (dir, file)` where `dir`/`file` are promoted `string?` locals)
                // is promoted per-element to `(string?, string?)`, otherwise the
                // `(string?, string?) -> (string, string)` return is rejected
                // (GS0155). Applied before the scalar promotion below (which is a
                // no-op for a tuple value type).
                mapped = this.PromoteTupleReturnIfTainted(mapped, returnType, node);

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
                if (returnType is INamedTypeSymbol { IsGenericType: true } taskLikeSync &&
                    taskLikeSync.TypeArguments.Length == 1 &&
                    taskLikeSync.ContainingNamespace?.ToDisplayString() == "System.Threading.Tasks" &&
                    taskLikeSync.Name is "Task" or "ValueTask")
                {
                    return this.PromoteTaskEnvelopeReturnIfTainted(mapped, taskLikeSync.TypeArguments[0], symbol);
                }

                // Issue #2113: promote the return type to `T?` through the same
                // shared symbol-position decision used by every declaration sink.
                return this.PromoteReturnIfTainted(mapped, symbol);
            }

            return node.ReturnType is PredefinedTypeSyntax predefined &&
                predefined.Keyword.IsKind(SyntaxKind.VoidKeyword)
                    ? null
                    : new NamedTypeReference(CSharpTypeMapper.UnsupportedPlaceholderType);
        }

        private static bool IsIteratorBody(MethodDeclarationSyntax node)
        {
            SyntaxNode body = (SyntaxNode)node.Body ?? node.ExpressionBody;
            if (body == null)
            {
                return false;
            }

            // A `yield` inside a nested local function belongs to that function, not
            // to this method, so descendants under a local-function boundary are
            // excluded from the iterator test.
            return body.DescendantNodes(n => n is not LocalFunctionStatementSyntax)
                .OfType<YieldStatementSyntax>()
                .Any();
        }

        private List<AttributeUse> MapAttributes(IEnumerable<AttributeListSyntax> attributeLists)
        {
            var attributes = new List<AttributeUse>();
            foreach (AttributeListSyntax list in attributeLists)
            {
                string target = list.Target?.Identifier.Text;
                foreach (AttributeSyntax attribute in list.Attributes)
                {
                    var arguments = new List<AttributeArgument>();
                    if (attribute.ArgumentList != null)
                    {
                        foreach (AttributeArgumentSyntax argument in attribute.ArgumentList.Arguments)
                        {
                            GExpression value = this.MapAttributeArgumentValue(argument);
                            string name = argument.NameEquals?.Name.Identifier.Text
                                ?? argument.NameColon?.Name.Identifier.Text;
                            arguments.Add(new AttributeArgument(value, name));
                        }
                    }

                    string attributeName = this.TranslateAttributeName(attribute.Name);

                    attributes.Add(new AttributeUse(attributeName, arguments, target));
                }
            }

            return attributes;
        }

        // Issue #1913: a C# 11 generic attribute (`[Tag<int>]`) parses its type
        // arguments in ANGLE brackets, so `nameSyntax.ToString()` carries them as
        // `Tag<int>` verbatim. G# has no angle-bracket syntax at all (ADR-0020) —
        // every generic construct, including a generic attribute, spells its
        // type-argument list in SQUARE brackets. Reuse the same
        // <see cref="MapTypeArguments"/>/<see cref="GSharpPrinter.RenderTypeReference"/>
        // path a generic type reference or generic call already routes through,
        // rather than hand-rolling the bracket text, so an unsupported/unresolvable
        // type argument still gets the placeholder the type mapper already emits.
        private string TranslateAttributeName(NameSyntax nameSyntax)
        {
            string attributeName = nameSyntax.ToString();
            int aliasSeparator = attributeName.IndexOf("::", System.StringComparison.Ordinal);
            if (aliasSeparator >= 0)
            {
                // Strip a `global::` (or extern-alias) qualifier; G# has no
                // alias-qualified name syntax.
                attributeName = attributeName.Substring(aliasSeparator + 2);
            }

            GenericNameSyntax generic = nameSyntax switch
            {
                GenericNameSyntax g => g,
                QualifiedNameSyntax { Right: GenericNameSyntax g } => g,
                AliasQualifiedNameSyntax { Name: GenericNameSyntax g } => g,
                _ => null,
            };

            if (generic == null)
            {
                return attributeName;
            }

            IReadOnlyList<GTypeReference> typeArguments = this.MapTypeArguments(generic);
            string baseName = attributeName.Substring(0, attributeName.IndexOf('<'));
            string typeArgumentList = string.Join(", ", typeArguments.Select(GSharpPrinter.RenderTypeReference));
            return $"{baseName}[{typeArgumentList}]";
        }

        // Issue #1731 N1: attribute-argument expressions here can never be an
        // `is`-pattern or a range-slice (i.e. can never reach `SpillOperand`'s
        // no-seam fallback) — C# requires every attribute argument to be a
        // compile-time constant (or a `typeof`/array of constants), and
        // neither an `is` pattern-match nor a `x[a..b]` range-slice is ever a
        // constant expression. So the double-evaluation gap this file
        // otherwise guards against has no way to reach this call site.
        private GExpression MapAttributeArgumentValue(AttributeArgumentSyntax argument)
        {
            Optional<object> constant = this.context.SemanticModel.GetConstantValue(argument.Expression);
            if (constant.HasValue)
            {
                // Issue #1733: an enum-typed attribute argument (e.g.
                // `[Kind(Color.Blue)]`) constant-folds to its boxed underlying
                // integer just like an enum-typed parameter default; resolve it to
                // the member reference via the same helper used for
                // <see cref="MapConstantDefault"/> rather than emit the raw int
                // (see <see cref="MapEnumConstant"/> remarks on renumbering).
                ITypeSymbol argumentType = this.context.GetTypeInfo(argument.Expression).ConvertedType;
                if (constant.Value != null && argumentType?.TypeKind == TypeKind.Enum && IsIntegral(constant.Value))
                {
                    GExpression enumValue = this.MapEnumConstant(
                        argumentType, constant.Value, argument, "attribute argument");
                    if (enumValue != null)
                    {
                        return enumValue;
                    }
                }

                switch (constant.Value)
                {
                    case null:
                        return new IdentifierExpression("nil");
                    case string s:
                        return LiteralExpression.String(s);
                    case bool b:
                        return new IdentifierExpression(b ? "true" : "false");
                    case char c:
                        return LiteralExpression.Char(c.ToString());
                    case double d when MapSpecialFloatConstant(d, isDouble: true) is { } specialD:
                        return specialD;
                    case float f when MapSpecialFloatConstant(f, isDouble: false) is { } specialF:
                        return specialF;
                    default:
                        if (IsIntegral(constant.Value))
                        {
                            return LiteralExpression.Int(
                                System.Convert.ToString(constant.Value, CultureInfo.InvariantCulture));
                        }

                        break;
                }
            }

            // A non-constant attribute argument (an array of constants like
            // `[InlineData(new[] { 3, 1 })]`, a `typeof(X)`, ...) goes through the
            // ordinary expression translator: emitting the verbatim C# text here
            // (the old fallback) produced non-parsing G# — `new[] { … }` can never
            // round-trip — which violates the §B contract that every emitted form
            // is parseable. Constructs the expression translator cannot map still
            // surface loudly through its own diagnostics.
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.AttributeArgument),
                "attribute argument is not a simple constant; translated as an expression (ADR-0115 §B.11).",
                argument.GetLocation(),
                TranslationSeverity.Info));
            return this.TranslateExpression(argument.Expression);
        }

        /// <summary>
        /// The single body-translation seam (ADR-0115 §B): a recursive statement /
        /// expression translator over the C# body that produces a parseable G#
        /// <see cref="BlockStatement"/>. Constructs with no canonical G# form are
        /// recorded as structured <see cref="TranslationDiagnostic"/> records and
        /// emit the nearest parseable placeholder — never non-parsing text.
        /// </summary>
        /// <param name="bodyOwner">The C# node that owns the body.</param>
        /// <param name="description">A human-readable label for the body.</param>
        /// <returns>The translated block.</returns>
        private BlockStatement TranslateBody(SyntaxNode bodyOwner, string description)
        {
            SyntaxNode previousScope = this.state.CurrentBodyScope;
            this.state.CurrentBodyScope = bodyOwner;
            try
            {
                BlockStatement body = this.TranslateBodyCore(bodyOwner, description);
                return this.WithParameterShadows(bodyOwner, body);
            }
            finally
            {
                this.state.CurrentBodyScope = previousScope;
            }
        }

        // Issue #1278 / ADR-0131: a C# expression-bodied member (`=> expr`)
        // translates to the idiomatic G# arrow form (`-> expr`) when the
        // translated body folds to a single, inline-renderable statement. A
        // value-returning body is `{ return expr }`; a void body is a single
        // expression or assignment statement. Bodies that needed extra
        // statements (parameter shadows, hoisted temporaries, a bare `throw`
        // expression, or an `unsafe { }` wrap) do not fold and keep their block
        // body so the emitted G# stays correct.
        private static GStatement TryFoldArrowBody(BlockStatement block)
        {
            if (block == null || block.IsUnsafe || block.Statements.Count != 1)
            {
                return null;
            }

            GStatement only = block.Statements[0];
            return only switch
            {
                ReturnStatement r when r.Expression != null => r,
                ExpressionStatement => only,
                AssignmentStatement => only,
                _ => null,
            };
        }

        // G# function parameters are read-only (Kotlin-style); a C# method that
        // reassigns a value parameter must shadow it with a mutable local at the top
        // of the body (`var p = p`) so the later writes are legal. Parameters that
        // are never reassigned, or that are already `ref`/`out`/`in`, are left alone.
        private BlockStatement WithParameterShadows(SyntaxNode bodyOwner, BlockStatement body)
        {
            BaseParameterListSyntax parameterList = bodyOwner switch
            {
                MethodDeclarationSyntax method => method.ParameterList,
                OperatorDeclarationSyntax op => op.ParameterList,
                ConversionOperatorDeclarationSyntax conversion => conversion.ParameterList,
                ConstructorDeclarationSyntax ctor => ctor.ParameterList,
                LocalFunctionStatementSyntax localFunction => localFunction.ParameterList,
                _ => null,
            };

            if (parameterList == null || parameterList.Parameters.Count == 0)
            {
                return body;
            }

            var shadows = new List<GStatement>();
            foreach (ParameterSyntax parameter in parameterList.Parameters)
            {
                if (this.context.GetDeclaredSymbol(parameter) is not IParameterSymbol symbol
                    || symbol.RefKind != RefKind.None
                    || !this.IsSymbolReassigned(symbol, bodyOwner))
                {
                    continue;
                }

                string name = SanitizeIdentifier(parameter.Identifier.Text);
                shadows.Add(new LocalDeclarationStatement(
                    BindingKind.Var, name, type: null, new IdentifierExpression(name)));
            }

            if (shadows.Count == 0)
            {
                return body;
            }

            shadows.AddRange(body.Statements);
            return new BlockStatement(shadows, body.IsUnsafe);
        }

        private BlockStatement TranslateBodyCore(SyntaxNode bodyOwner, string description)
        {
            switch (bodyOwner)
            {
                case MethodDeclarationSyntax method:
                    if (method.Body != null)
                    {
                        return this.TranslateBlock(method.Body);
                    }

                    if (method.ExpressionBody != null)
                    {
                        bool returnsVoid =
                            (this.context.GetDeclaredSymbol(method) as IMethodSymbol)?.ReturnsVoid ?? false;
                        return this.WrapExpressionBody(method.ExpressionBody.Expression, returnsVoid);
                    }

                    break;

                case OperatorDeclarationSyntax op:
                    if (op.Body != null)
                    {
                        return this.TranslateBlock(op.Body);
                    }

                    if (op.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(op.ExpressionBody.Expression, isVoid: false);
                    }

                    break;

                case ConversionOperatorDeclarationSyntax conversion:
                    if (conversion.Body != null)
                    {
                        return this.TranslateBlock(conversion.Body);
                    }

                    if (conversion.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(conversion.ExpressionBody.Expression, isVoid: false);
                    }

                    break;

                case ConstructorDeclarationSyntax ctor:

                    if (ctor.Body != null)
                    {
                        return this.TranslateBlock(ctor.Body);
                    }

                    if (ctor.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(ctor.ExpressionBody.Expression, isVoid: true);
                    }

                    break;

                case AccessorDeclarationSyntax accessor:
                    if (accessor.Body != null)
                    {
                        return this.TranslateBlock(accessor.Body);
                    }

                    if (accessor.ExpressionBody != null)
                    {
                        bool isGetter = accessor.IsKind(SyntaxKind.GetAccessorDeclaration);
                        return this.WrapExpressionBody(accessor.ExpressionBody.Expression, isVoid: !isGetter);
                    }

                    break;

                case PropertyDeclarationSyntax property when property.ExpressionBody != null:
                    // An expression-bodied property is a get-only computed property.
                    return this.WrapExpressionBody(property.ExpressionBody.Expression, isVoid: false);

                case IndexerDeclarationSyntax indexer when indexer.ExpressionBody != null:
                    // An expression-bodied indexer is a get-only computed indexer.
                    return this.WrapExpressionBody(indexer.ExpressionBody.Expression, isVoid: false);

                case DestructorDeclarationSyntax destructor:
                    if (destructor.Body != null)
                    {
                        return this.TranslateBlock(destructor.Body);
                    }

                    if (destructor.ExpressionBody != null)
                    {
                        return this.WrapExpressionBody(destructor.ExpressionBody.Expression, isVoid: true);
                    }

                    break;

                // Issue #2382: a capture-free top-level local function is hoisted
                // to a genuine top-level `func` (see
                // <see cref="TranslateTopLevelLocalFunctionAsFunc"/>), which
                // routes its body through this SAME seam (rather than the
                // `let`-bound function-literal path <see cref="TranslateLocalFunction"/>
                // uses for an in-place/captured local function) so a hoisted
                // local function's body gets identical spill/parameter-shadow/
                // unsafe handling to an ordinary method's.
                case LocalFunctionStatementSyntax localFunction:
                    if (localFunction.Body != null)
                    {
                        return this.TranslateBlock(localFunction.Body);
                    }

                    if (localFunction.ExpressionBody != null)
                    {
                        bool returnsVoidLocal =
                            (this.context.GetDeclaredSymbol(localFunction) as IMethodSymbol)?.ReturnsVoid ?? false;
                        return this.WrapExpressionBody(localFunction.ExpressionBody.Expression, returnsVoidLocal);
                    }

                    break;
            }

            // No recognizable body; emit an empty parseable block.
            return new BlockStatement(new List<GStatement>());
        }

        private BlockStatement WrapExpressionBody(ExpressionSyntax expression, bool isVoid)
        {
            if (expression is ThrowExpressionSyntax bareThrow)
            {
                // `=> throw e` is a diverging body; G# `throw` is a statement, so
                // emit it directly rather than wrapping a value (ADR-0115 §B).
                return new BlockStatement(new List<GStatement>
                {
                    new ThrowStatement(this.TranslateExpression(bareThrow.Expression)),
                });
            }

            if (isVoid)
            {
                // A void expression body is an executed statement (often an
                // assignment, which is statement-only in G#), so route it through
                // the statement seam rather than wrapping the value. It behaves
                // like `TranslateStatement` for spill-hoisting purposes (issue
                // #1731): it has no OUTER statement of its own, so it opens its
                // own seam via <see cref="WithSpillSeam"/>.
                return new BlockStatement(this.WithSpillSeam(
                    () => this.TranslateExpressionStatements(expression).ToList()).ToList());
            }

            // A non-void expression body is a `return expr`. Route the returned
            // value through the null-forgiveness pass (issue #1354) exactly like
            // a statement-form `return expr;` does, so a promoted-nullable value
            // (`T?`) returned where the member is declared non-null `T` gets its
            // flow-proven `!!` assertion (e.g. `prop OperationTask Task ->
            // Continuation!!`). Using plain TranslateExpression here left
            // expression-bodied members without the assertion → GS0155.
            return new BlockStatement(this.WithSpillSeam(() => this.WithHoistedPostfix(
                expression,
                () => this.WithHoistedAssignments(
                    expression,
                    includeSelf: true,
                    () => new List<GStatement> { new ReturnStatement(this.TranslateValueWithNullForgiveness(expression)) })).ToList()).ToList());
        }

        private BlockStatement TranslateBlock(BlockSyntax block)
        {
            var statements = new List<GStatement>();
            foreach (StatementSyntax statement in this.HoistCallBeforeDeclLocalFunctions(block))
            {
                statements.AddRange(this.TranslateStatement(statement));
            }

            return new BlockStatement(statements);
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
        private IReadOnlyList<StatementSyntax> HoistCallBeforeDeclLocalFunctions(BlockSyntax block) =>
            this.HoistCallBeforeDeclLocalFunctions(block.Statements, block.Span);

        // Issue #2382: the C# top-level-statements entry point has no enclosing
        // `BlockSyntax` (its statements are sibling `GlobalStatementSyntax`
        // members directly under the compilation unit — see
        // <see cref="TranslateTopLevelProgram"/>), so the hoist algorithm is
        // generalized to any flat statement sequence plus the `TextSpan` that
        // bounds "sibling of this sequence" (a real block's own span, or the
        // union span of every top-level statement for the synthesized entry).
        private IReadOnlyList<StatementSyntax> HoistCallBeforeDeclLocalFunctions(
            IReadOnlyList<StatementSyntax> statements, TextSpan enclosingSpan)
        {
            var localFunctions = statements.OfType<LocalFunctionStatementSyntax>().ToList();
            if (localFunctions.Count == 0)
            {
                return statements;
            }

            // (function, anchor index to insert after; null = front of block)
            var toHoist = new List<(LocalFunctionStatementSyntax Function, int DeclIndex, int? AnchorIndex)>();
            foreach (LocalFunctionStatementSyntax localFunction in localFunctions)
            {
                int declIndex = IndexOfReference(statements, localFunction);
                if (this.context.GetDeclaredSymbol(localFunction) is not IMethodSymbol funcSymbol)
                {
                    continue;
                }

                int firstUseIndex = -1;
                for (int i = 0; i < declIndex; i++)
                {
                    bool usedHere = statements[i]
                        .DescendantNodes()
                        .OfType<IdentifierNameSyntax>()
                        .Any(id => id.Identifier.Text == localFunction.Identifier.Text
                            && SymbolEqualityComparer.Default.Equals(
                                this.context.GetSymbolInfo(id).Symbol, funcSymbol));
                    if (usedHere)
                    {
                        firstUseIndex = i;
                        break;
                    }
                }

                if (firstUseIndex < 0)
                {
                    // Never referenced ahead of its declaration — leave in place.
                    continue;
                }

                int? barrierIndex = this.SiblingCaptureBarrierIndex(localFunction, enclosingSpan, statements);
                int anchorIndex = barrierIndex.HasValue ? barrierIndex.Value + 1 : 0;
                if (anchorIndex > firstUseIndex)
                {
                    // The captured sibling local is declared after the first use,
                    // so there is no valid position for the `let` binding — leave
                    // it in place (pre-existing, unrelated ordering conflict).
                    continue;
                }

                toHoist.Add((localFunction, declIndex, barrierIndex));
            }

            if (toHoist.Count == 0)
            {
                return statements;
            }

            var hoistSet = new HashSet<StatementSyntax>(toHoist.Select(t => (StatementSyntax)t.Function));
            var reordered = statements.Where(s => !hoistSet.Contains(s)).ToList();

            // Group by anchor statement (the sibling local's declaring statement,
            // or the front of the block) and re-insert each group, preserving the
            // original relative order of the local functions within the group.
            foreach (var group in toHoist
                .OrderBy(t => t.DeclIndex)
                .GroupBy(t => t.AnchorIndex.HasValue ? statements[t.AnchorIndex.Value] : null))
            {
                int insertAt = group.Key is null ? 0 : reordered.IndexOf(group.Key) + 1;
                reordered.InsertRange(insertAt, group.Select(t => (StatementSyntax)t.Function));
            }

            return reordered;
        }

        // `SyntaxList<T>`/`List<T>` both expose `IndexOf`, but the generalized
        // `IReadOnlyList<StatementSyntax>` overload above does not — this finds
        // the same (reference-identity) index for either concrete backing store.
        private static int IndexOfReference(IReadOnlyList<StatementSyntax> statements, StatementSyntax target)
        {
            for (int i = 0; i < statements.Count; i++)
            {
                if (ReferenceEquals(statements[i], target))
                {
                    return i;
                }
            }

            return -1;
        }

        // Returns the index (within `statements`) of the last statement that
        // declares a local variable captured by `localFunction` from the
        // enclosing block — the `let` binding must not be hoisted above this
        // point. Returns null when no sibling local is captured (references to
        // the enclosing method's parameters, outer-scope locals, or the
        // function's own locals/parameters don't count — those remain in scope
        // at the front of the block).
        private int? SiblingCaptureBarrierIndex(
            LocalFunctionStatementSyntax localFunction, TextSpan enclosingSpan, IReadOnlyList<StatementSyntax> statements)
        {
            int? barrier = null;
            foreach (IdentifierNameSyntax id in localFunction.DescendantNodes().OfType<IdentifierNameSyntax>())
            {
                if (this.context.GetSymbolInfo(id).Symbol is not ILocalSymbol local)
                {
                    continue;
                }

                foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
                {
                    SyntaxNode declaration = reference.GetSyntax();

                    // A local declared inside the function's own body is safe.
                    if (localFunction.Span.Contains(declaration.Span))
                    {
                        continue;
                    }

                    // Not a sibling of this block (e.g. an outer-scope local) —
                    // already in scope wherever the `let` binding lands.
                    if (!enclosingSpan.Contains(declaration.Span))
                    {
                        continue;
                    }

                    for (int i = 0; i < statements.Count; i++)
                    {
                        if (statements[i].Span.Contains(declaration.Span)
                            && (barrier is null || i > barrier))
                        {
                            barrier = i;
                        }
                    }
                }
            }

            return barrier;
        }

        private IEnumerable<GStatement> TranslateFixedStatement(FixedStatementSyntax node)
        {
            // Translate the innermost body once; multiple declarators nest as
            // successive `fixed` blocks (`fixed a … { fixed b … { body } }`).
            BlockStatement body = this.TranslateStatementAsBlock(node.Statement);

            VariableDeclarationSyntax declaration = node.Declaration;
            GTypeReference pointerType = this.MapTypeSyntax(declaration.Type);

            for (int i = declaration.Variables.Count - 1; i >= 0; i--)
            {
                VariableDeclaratorSyntax declarator = declaration.Variables[i];
                GExpression source = declarator.Initializer != null
                    ? this.TranslateExpression(declarator.Initializer.Value)
                    : new IdentifierExpression("nil");
                body = new BlockStatement(new GStatement[]
                {
                    new FixedStatement(
                        SanitizeIdentifier(declarator.Identifier.Text),
                        pointerType,
                        source,
                        body),
                });
            }

            // Unwrap the single outer wrapper block so the caller receives the
            // `fixed` statement(s) directly.
            return body.Statements;
        }

        private BlockStatement TranslateStatementAsBlock(StatementSyntax statement)
        {
            if (statement is BlockSyntax block)
            {
                return this.TranslateBlock(block);
            }

            return new BlockStatement(this.TranslateStatement(statement).ToList());
        }

        // Establishes a fresh statement seam (issue #1731) around each statement's
        // translation: any spill hoisted while translating `statement` (see
        // <see cref="SpillOperand"/>) is collected into its own prologue and
        // emitted immediately ahead of `statement`'s own output, then the ambient
        // seam is restored — so a nested statement (e.g. a block's own children)
        // always gets its own independent seam rather than sharing this one.
        private IEnumerable<GStatement> TranslateStatement(StatementSyntax statement)
        {
            List<GStatement> outerSpillPrologue = this.state.PendingSpillPrologue;
            var spillPrologue = new List<GStatement>();
            this.state.PendingSpillPrologue = spillPrologue;
            try
            {
                List<GStatement> core = this.TranslateStatementCore(statement).ToList();
                if (spillPrologue.Count == 0)
                {
                    return core;
                }

                var combined = new List<GStatement>(spillPrologue);
                combined.AddRange(core);
                return combined;
            }
            finally
            {
                this.state.PendingSpillPrologue = outerSpillPrologue;
            }
        }

        private IEnumerable<GStatement> TranslateStatementCore(StatementSyntax statement)
        {
            switch (statement)
            {
                case LocalDeclarationStatementSyntax local:
                    return this.TranslateLocalDeclaration(
                        local.Declaration,
                        local.IsConst,
                        isUsing: local.UsingKeyword != default,
                        isAwait: !local.AwaitKeyword.IsKind(SyntaxKind.None));

                case ExpressionStatementSyntax expressionStatement:
                    // ADR-0143 §D rule 1: an expression statement whose
                    // invocation binds to an ELIDED unimplemented partial method
                    // is dropped. A deletable C# partial method is necessarily
                    // `void` with no `out` parameters and is only ever invoked in
                    // statement position (MVVM's `OnFooChanged(...)`), so dropping
                    // the whole statement is safe and complete.
                    if (this.IsElidedPartialMethodInvocation(expressionStatement.Expression))
                    {
                        return System.Array.Empty<GStatement>();
                    }

                    return this.TranslateExpressionStatements(expressionStatement.Expression);

                case BreakStatementSyntax:
                    return new[] { (GStatement)new BreakStatement() };

                case ContinueStatementSyntax:
                    return new[] { (GStatement)new ContinueStatement() };

                case LabeledStatementSyntax labeledStatement:
                    return this.TranslateLabeledStatement(labeledStatement);

                case GotoStatementSyntax gotoStatement:
                    return this.TranslateGotoStatement(gotoStatement);

                case DoStatementSyntax doStatement:
                    if (this.TryTranslateLoopWithConditionHoist(
                            doStatement.Condition,
                            doStatement.Statement,
                            isDoWhile: true,
                            out IReadOnlyList<GStatement> doHoisted))
                    {
                        return doHoisted;
                    }

                    return new[]
                    {
                        (GStatement)new DoWhileStatement(
                            this.TranslateStatementAsBlock(doStatement.Statement),
                            this.TranslateExpression(doStatement.Condition)),
                    };

                case LockStatementSyntax lockStatement:
                    return new[] { this.TranslateLock(lockStatement) };

                case LocalFunctionStatementSyntax localFunction:
                    return new[] { this.TranslateLocalFunction(localFunction) };

                case CheckedStatementSyntax checkedStatement:
                    // Issue #1881: a C# `checked { }`/`unchecked { }` block maps to
                    // the G# `checked { }`/`unchecked { }` block (gsc now supports
                    // both natively), introducing a checked/unchecked arithmetic
                    // context instead of silently dropping the overflow semantics.
                    return new[]
                    {
                        (GStatement)new BlockStatement(
                            this.TranslateBlock(checkedStatement.Block).Statements,
                            isChecked: checkedStatement.IsKind(SyntaxKind.CheckedStatement),
                            isUnchecked: checkedStatement.IsKind(SyntaxKind.UncheckedStatement)),
                    };

                case UnsafeStatementSyntax unsafeStatement:
                    // ADR-0122 / issue #1014: a C# `unsafe { … }` block maps to the
                    // G# `unsafe { … }` block, introducing an unsafe context.
                    return new[]
                    {
                        (GStatement)new BlockStatement(
                            this.TranslateBlock(unsafeStatement.Block).Statements,
                            isUnsafe: true),
                    };

                case FixedStatementSyntax fixedStatement:
                    // gsc issue #1026: a C# `fixed (T* p = src) { … }` pins a managed
                    // array/string and exposes a raw pointer, mapping to the G#
                    // `fixed p *T = src { … }` form (only legal inside `unsafe`).
                    return this.TranslateFixedStatement(fixedStatement);

                case ReturnStatementSyntax ret:
                {
                    if (ret.Expression == null)
                    {
                        return new[] { (GStatement)new ReturnStatement(null) };
                    }

                    // `return (x = M());` — a value-position assignment in the
                    // return expression is hoisted into a preceding assignment
                    // statement; it runs once, exactly where C# would evaluate it
                    // (issue #1723).
                    var returnPrologue = new List<GStatement>();
                    List<AssignmentExpressionSyntax> returnEmbedded =
                        this.CollectEmbeddedAssignments(ret.Expression, includeSelf: true);
                    foreach (AssignmentExpressionSyntax node in returnEmbedded)
                    {
                        returnPrologue.AddRange(this.FlattenChainedAssignment(node));
                    }

                    foreach (AssignmentExpressionSyntax node in returnEmbedded)
                    {
                        this.state.SuppressedAssignments.Add(node);
                    }

                    GExpression returnValue;
                    try
                    {
                        returnValue = this.TranslateValueWithNullForgiveness(ret.Expression);
                    }
                    finally
                    {
                        foreach (AssignmentExpressionSyntax node in returnEmbedded)
                        {
                            this.state.SuppressedAssignments.Remove(node);
                        }
                    }

                    returnPrologue.Add(new ReturnStatement(
                        this.CoercePointerConversion(ret.Expression, returnValue),
                        isRef: ret.Expression is RefExpressionSyntax));
                    return returnPrologue;
                }

                case IfStatementSyntax ifStatement:
                    return this.TranslateIfStatements(ifStatement).ToArray();

                case WhileStatementSyntax whileStatement:
                    if (this.TryTranslateLoopWithConditionHoist(
                            whileStatement.Condition,
                            whileStatement.Statement,
                            isDoWhile: false,
                            out IReadOnlyList<GStatement> whileHoisted))
                    {
                        return whileHoisted;
                    }

                    return new[]
                    {
                        (GStatement)new WhileStatement(
                            GuardBlockCondition(this.TranslateExpression(whileStatement.Condition)),
                            this.TranslateStatementAsBlock(whileStatement.Statement)),
                    };

                case ForStatementSyntax forStatement:
                    return new[] { this.TranslateForStatement(forStatement) };

                case ForEachStatementSyntax forEach:
                    // Issue #1967: `foreach (Index i in xs)` declares `i` directly
                    // on this node (no declarator, no designation) — check it here
                    // before it can bypass the issue #1894 loud-gap guard.
                    this.ReportIfIndexOrRangeTypedForEachVariable(forEach);

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
                    return new[]
                    {
                        (GStatement)new ForInStatement(
                            SanitizeIdentifier(forEach.Identifier.Text),
                            this.TranslateReceiverWithNullForgiveness(forEach.Expression),
                            this.TranslateStatementAsBlock(forEach.Statement),
                            isAwait: !forEach.AwaitKeyword.IsKind(SyntaxKind.None)),
                    };

                case ForEachVariableStatementSyntax forEachVariable:
                    return new[] { this.TranslateForEachVariable(forEachVariable) };

                case ThrowStatementSyntax throwStatement:
                    return new[] { this.TranslateThrow(throwStatement) };

                case TryStatementSyntax tryStatement:
                    return new[] { this.TranslateTry(tryStatement) };

                case UsingStatementSyntax usingStatement:
                    return new[] { this.TranslateUsingStatement(usingStatement) };

                case BlockSyntax block:
                    return new[] { (GStatement)this.TranslateBlock(block) };

                case SwitchStatementSyntax switchStatement:
                    return new[] { this.TranslateSwitchStatement(switchStatement) };

                case YieldStatementSyntax yieldStatement:
                    return this.TranslateYieldStatement(yieldStatement);

                case EmptyStatementSyntax:
                    return System.Array.Empty<GStatement>();

                default:
                    this.context.ReportUnsupported(
                        statement,
                        $"statement '{statement.Kind()}' has no canonical G# form yet; emitted a placeholder comment (ADR-0115 §B).");
                    return new[] { (GStatement)new RawStatement($"// unsupported: {statement.Kind()}") };
            }
        }
    }
}
