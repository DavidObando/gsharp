// <copyright file="CSharpToGSharpTranslator.Declarations.cs" company="GSharp">
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
        /// <summary>
        /// Removes and returns the top-level declarations (lifted owned-struct
        /// receiver methods, issue #938) collected while translating the most
        /// recent aggregate, so the document translator can emit them as siblings.
        /// </summary>
        /// <returns>The collected top-level declarations (possibly empty).</returns>
        public IReadOnlyList<GMember> DrainPendingTopLevel()
        {
            if (this.state.PendingTopLevelDeclarations.Count == 0)
            {
                return System.Array.Empty<GMember>();
            }

            var drained = new List<GMember>(this.state.PendingTopLevelDeclarations);
            this.state.PendingTopLevelDeclarations.Clear();
            return drained;
        }

        public override GMember VisitEnumDeclaration(EnumDeclarationSyntax node)
        {
            ISymbol symbol = this.context.GetDeclaredSymbol(node);
            var cases = new List<EnumCase>();

            // Issue #1912 N1: reinterpret each constant's bits per the C# enum's
            // OWN underlying type (byte/short/int/long and their unsigned
            // counterparts) via the shared `ToEnumBitPattern` helper (also used by
            // `MapEnumConstant`) rather than `Convert.ToInt64` directly —
            // `Convert.ToInt64` throws `OverflowException` on a `ulong` constant
            // above `long.MaxValue` (e.g. a `[Flags] enum X : ulong` high-bit
            // member), which would otherwise crash the translator.
            SpecialType underlyingType = (symbol as INamedTypeSymbol)?.EnumUnderlyingType?.SpecialType ?? SpecialType.System_Int32;

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
            int nextOrdinal = 0;
            foreach (EnumMemberDeclarationSyntax member in node.Members)
            {
                int? explicitValue = null;
                if (this.context.GetDeclaredSymbol(member) is IFieldSymbol { HasConstantValue: true } fieldSymbol)
                {
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
                    ulong bits = ToEnumBitPattern(fieldSymbol.ConstantValue, underlyingType);
                    int candidate = unchecked((int)(uint)bits);
                    bool is64BitWidth = underlyingType == SpecialType.System_Int64 || underlyingType == SpecialType.System_UInt64;
                    bool fitsInt32 = !is64BitWidth || unchecked((ulong)(long)candidate) == bits;
                    if (!fitsInt32)
                    {
                        // G# enums are always int32-backed (issue #1912 doesn't
                        // extend to non-default underlying types); a value outside
                        // int32 range has no faithful G# spelling, so fall back to
                        // the (already-wrong, but non-crashing) auto-numbered
                        // ordinal and flag it visibly rather than silently.
                        this.context.Report(new TranslationDiagnostic(
                            nameof(SyntaxKind.EnumMemberDeclaration),
                            $"enum case '{member.Identifier.Text}' has a constant value outside the int32 range G# enums support; the value is dropped.",
                            member.GetLocation(),
                            TranslationSeverity.Info));
                        nextOrdinal++;
                        cases.Add(new EnumCase(SanitizeIdentifier(member.Identifier.Text)));
                        continue;
                    }

                    var constantValue = candidate;
                    if (constantValue != nextOrdinal)
                    {
                        explicitValue = constantValue;
                    }

                    nextOrdinal = constantValue + 1;
                }
                else
                {
                    nextOrdinal++;
                }

                cases.Add(new EnumCase(SanitizeIdentifier(member.Identifier.Text), explicitValue: explicitValue));
            }

            return new EnumDeclaration(
                SanitizeIdentifier(node.Identifier.Text),
                cases,
                MapVisibility(symbol, this.context, node),
                attributes: this.MapAttributes(node.AttributeLists));
        }

        public override GMember DefaultVisit(SyntaxNode node)
        {
            this.context.ReportUnsupported(
                node,
                $"'{node.Kind()}' has no canonical G# declaration mapping; recorded for triage (ADR-0115 §B).");
            return null;
        }

        /// <summary>
        /// T3 (ADR-0115 §B.1/§B.11): translates the C# program entry point's
        /// enclosing static class into top-level G#. The entry method's body
        /// becomes top-level statements (the G# program entry), and every other
        /// static method becomes a top-level <c>func</c>. The class itself — and
        /// any <c>shared { }</c> wrapping — is dropped.
        /// </summary>
        /// <param name="node">The entry point's enclosing type declaration.</param>
        /// <param name="entryPoint">The bound entry-point method symbol.</param>
        /// <returns>The hoisted top-level funcs and the entry top-level statements.</returns>
        public (IReadOnlyList<GNode> Funcs, IReadOnlyList<GNode> Statements) TranslateEntryType(
            TypeDeclarationSyntax node,
            IMethodSymbol entryPoint)
        {
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.ClassDeclaration),
                $"C# entry point '{entryPoint.ContainingType.Name}.{entryPoint.Name}' and its enclosing static class are hoisted to top level: the entry body becomes top-level statements and sibling static methods become top-level 'func's (no 'shared {{ }}' block) (ADR-0115 §B.1/§B.11 / T3).",
                node.GetLocation(),
                TranslationSeverity.Info));

            var funcs = new List<GNode>();
            var statements = new List<GNode>();

            foreach (MemberDeclarationSyntax member in node.Members)
            {
                switch (member)
                {
                    case MethodDeclarationSyntax method
                        when SymbolEqualityComparer.Default.Equals(
                            this.context.GetDeclaredSymbol(method), entryPoint):
                        // Issue #1904: `Main`'s own `string[]` parameter may be
                        // named anything (`args`, `arguments`, …), but the
                        // top-level statements it is hoisted into only ever
                        // declare the fixed, implicit `args` slot (ADR-0066
                        // D1). Bind every reference to Main's parameter to that
                        // identifier — the same patternBindings substitution
                        // used for pattern-bound locals — for the duration of
                        // the entry body's translation only.
                        bool renamedArgs = entryPoint.Parameters.Length == 1
                            && entryPoint.Parameters[0].Name != "args";
                        if (renamedArgs)
                        {
                            this.state.PatternBindings[entryPoint.Parameters[0]] = new IdentifierExpression("args");
                        }

                        BlockStatement body = this.TranslateBody(method, $"entry point '{entryPoint.Name}'");
                        statements.AddRange(body.Statements);

                        if (renamedArgs)
                        {
                            this.state.PatternBindings.Remove(entryPoint.Parameters[0]);
                        }

                        break;

                    case MethodDeclarationSyntax method:
                        (GMember func, _) = this.TranslateMethod(method, TypeDeclarationKind.Class);
                        if (func != null)
                        {
                            funcs.Add(func);
                        }

                        break;

                    default:
                        this.context.ReportUnsupported(
                            member,
                            $"member '{member.Kind()}' of the entry class has no top-level G# mapping yet (ADR-0115 §B.11 / T3).");
                        break;
                }
            }

            return (funcs, statements);
        }

        /// <summary>
        /// Issue #2382: translates a native C# top-level-statements program
        /// (Roslyn's <c>GlobalStatementSyntax</c> members, with no enclosing
        /// class/method syntax at all — as opposed to <see cref="TranslateEntryType"/>,
        /// which hoists an EXPLICIT <c>Main</c> method's body) directly to G#
        /// top-level statements. G# already has native top-level-statement
        /// support (ADR-0066) with the exact same shape: an implicit <c>args</c>
        /// binding, top-level <c>await</c>, and a top-level <c>return</c> —
        /// so the translation is a straight statement-by-statement mapping
        /// through the SAME <see cref="TranslateStatement"/>/
        /// <see cref="HoistCallBeforeDeclLocalFunctions(BlockSyntax)"/> seams a
        /// method body uses, not a second parallel statement translator.
        /// <para>
        /// A top-level local function that captures no sibling top-level local
        /// (and does not read the implicit <c>args</c> parameter) is hoisted
        /// OUT to its own top-level G# <c>func</c> sibling declaration (see
        /// <see cref="TranslateTopLevelLocalFunctionAsFunc"/>) — G# funcs are
        /// pre-declared in binding scope regardless of textual order (ADR-0066),
        /// so this also gives such a local function unrestricted forward-
        /// reference support, unlike the ordered `let`-binding fallback used for
        /// a genuinely capturing local function (which keeps the existing
        /// call-before-decl hoist behavior, issue #2231).
        /// </para>
        /// </summary>
        /// <param name="globalStatements">Every top-level <c>GlobalStatementSyntax</c> in this file, in source order.</param>
        /// <param name="entryPoint">The synthesized top-level-statements entry-point method symbol.</param>
        /// <returns>The hoisted top-level funcs (capture-free local functions) and the entry's top-level statements.</returns>
        public (IReadOnlyList<GNode> Funcs, IReadOnlyList<GNode> Statements) TranslateTopLevelProgram(
            IReadOnlyList<GlobalStatementSyntax> globalStatements,
            IMethodSymbol entryPoint)
        {
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.GlobalStatement),
                "C# native top-level statements are translated directly to G# top-level statements (ADR-0066): a capture-free top-level local function is hoisted to a sibling top-level 'func', and a capturing one keeps its ordered 'let' binding among the statements (issue #2382).",
                globalStatements[0].GetLocation(),
                TranslationSeverity.Info));

            List<StatementSyntax> flatStatements = globalStatements.Select(gs => gs.Statement).ToList();
            TextSpan enclosingSpan = TextSpan.FromBounds(flatStatements[0].SpanStart, flatStatements[^1].Span.End);
            IReadOnlyList<StatementSyntax> ordered = this.HoistCallBeforeDeclLocalFunctions(flatStatements, enclosingSpan);

            // Issue #1904 (mirrored here): the synthesized top-level entry
            // point's own implicit parameter is always literally named "args"
            // (there is no C# source spelling to rename it from — unlike an
            // explicit `Main(string[] arguments)` — since the parameter is not
            // written by hand at all), but the rename guard is kept for
            // defense-in-depth in case a future Roslyn version ever changes
            // that assumption.
            IParameterSymbol argsParameter = entryPoint.Parameters.FirstOrDefault();
            bool renamedArgs = argsParameter != null && argsParameter.Name != "args";
            if (renamedArgs)
            {
                this.state.PatternBindings[argsParameter] = new IdentifierExpression("args");
            }

            var funcs = new List<GNode>();
            var statements = new List<GNode>();
            try
            {
                foreach (StatementSyntax statement in ordered)
                {
                    if (statement is LocalFunctionStatementSyntax localFunction
                        && this.context.GetDeclaredSymbol(localFunction) is IMethodSymbol localSymbol
                        && this.IsTopLevelLocalFunctionCaptureFree(localFunction, argsParameter, enclosingSpan))
                    {
                        GMember hoisted = this.TranslateTopLevelLocalFunctionAsFunc(localFunction, localSymbol);
                        if (hoisted != null)
                        {
                            funcs.Add(hoisted);
                            continue;
                        }
                    }

                    statements.AddRange(this.TranslateStatement(statement));
                }
            }
            finally
            {
                if (renamedArgs)
                {
                    this.state.PatternBindings.Remove(argsParameter);
                }
            }

            return (funcs, statements);
        }

        // The set of hard G# keywords (Cs2Gs.Compiler SyntaxFacts.GetKeywordKind).
        // A C# identifier that collides with one of these cannot be emitted bare; it
        // is suffixed with `_` consistently at every declaration and reference site.
        // Internal (not private) so the outer <see cref="CSharpToGSharpTranslator"/>
        // forwarding method can expose it to <see cref="CSharpTypeMapper"/>, which
        // routes type-name references through this exact sanitizer too (issue
        // #1734).
        internal static string SanitizeIdentifier(string name)
        {
            if (string.IsNullOrEmpty(name))
            {
                return name;
            }

            // C# verbatim identifiers (`@default`, `@class`) carry a leading `@`
            // in their syntax text; G# has no verbatim-identifier escape, so strip
            // it before the reserved-word check (the bare name is then suffixed if
            // it still collides with a G# keyword).
            if (name[0] == '@')
            {
                name = name.Substring(1);
            }

            return GSharpReservedWords.Contains(name) ? name + "_" : name;
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
        private bool IsTopLevelLocalFunctionCaptureFree(
            LocalFunctionStatementSyntax localFunction, IParameterSymbol argsParameter, TextSpan enclosingSpan)
        {
            // A `static` local function can never capture in C# (CS8421) — the
            // language guarantees this shape is already capture-free, so no
            // body walk is needed.
            if (localFunction.Modifiers.Any(SyntaxKind.StaticKeyword))
            {
                return true;
            }

            foreach (IdentifierNameSyntax id in localFunction.DescendantNodes().OfType<IdentifierNameSyntax>())
            {
                ISymbol symbol = this.context.GetSymbolInfo(id).Symbol;

                if (argsParameter != null && SymbolEqualityComparer.Default.Equals(symbol, argsParameter))
                {
                    // References the entry point's own implicit `args` — a
                    // hoisted top-level `func` is a sibling declaration with no
                    // implicit access to it, so this must stay an in-place
                    // closure instead.
                    return false;
                }

                if (symbol is not ILocalSymbol local)
                {
                    continue;
                }

                foreach (SyntaxReference reference in local.DeclaringSyntaxReferences)
                {
                    SyntaxNode declaration = reference.GetSyntax();
                    if (localFunction.Span.Contains(declaration.Span))
                    {
                        // Its own local (recursion, a nested block, ...) — fine.
                        continue;
                    }

                    if (enclosingSpan.Contains(declaration.Span))
                    {
                        // Captures a sibling top-level statement's local.
                        return false;
                    }
                }
            }

            return true;
        }

        // Issue #2382: translates a CAPTURE-FREE top-level local function into
        // its own top-level G# `func` sibling declaration — reusing the exact
        // same parameter/return-type/type-parameter mapping and the same
        // <see cref="TranslateBody"/> seam an ordinary method or the sibling
        // static methods of an explicit `Main`'s enclosing class already use
        // (<see cref="TranslateEntryType"/>), rather than the `let`-bound
        // function-LITERAL form <see cref="TranslateLocalFunction"/> emits for
        // an in-place/capturing local function.
        private GMember TranslateTopLevelLocalFunctionAsFunc(LocalFunctionStatementSyntax localFunction, IMethodSymbol symbol)
        {
            bool isAsync = localFunction.Modifiers.Any(m => m.IsKind(SyntaxKind.AsyncKeyword));
            List<Parameter> parameters = this.MapParameters(symbol, localFunction.ParameterList, skipFirst: false);
            GTypeReference returnType = this.MapDelegateLikeReturnType(symbol, isAsync, localFunction.ReturnType.GetLocation());
            List<TypeParameter> typeParameters = this.MapMethodTypeParameters(symbol);
            BlockStatement body = this.TranslateBody(localFunction, $"top-level local function '{localFunction.Identifier.Text}'");

            // A genuine top-level `func` declaration (unlike the function-LITERAL
            // form a non-hoisted local function lowers to) DOES support G#'s
            // native `ref` return modifier (ADR-0060/issue #490), so hoisting
            // incidentally lifts the "ref-returning local function has no
            // canonical form" gap (issue #1900) that still applies to a
            // captured/non-hoisted local function.
            return new MethodDeclaration(
                SanitizeIdentifier(localFunction.Identifier.Text),
                parameters,
                returnType,
                body,
                typeParameters,
                isAsync: isAsync,
                isRefReturn: symbol.ReturnsByRef);
        }

        /// <summary>
        /// Issue #1201 / ADR-0134: whether <paramref name="owner"/> is a type
        /// brought into unqualified static scope by a <c>using static</c>
        /// directive in this document. Bare references to such a type's static
        /// members are emitted unqualified (gsc hoists them through the bare
        /// type import) rather than qualified through the owning type name.
        /// </summary>
        /// <param name="owner">The static member's containing type.</param>
        /// <returns><c>true</c> when the owner is a <c>using static</c> target.</returns>
        private bool IsStaticUsingTarget(INamedTypeSymbol owner)
            => owner != null && this.staticUsingTargets.Contains(owner.OriginalDefinition);

        private static Visibility MapVisibility(
            ISymbol symbol,
            TranslationContext context,
            SyntaxNode node,
            bool preserveStaticClassPrivate = false)
        {
            if (symbol is null)
            {
                return Visibility.Default;
            }

            switch (symbol.DeclaredAccessibility)
            {
                case Accessibility.Public:
                    // public is the canonical default for both top-level and member
                    // positions, so it is omitted (ADR-0115 §B.10).
                    return Visibility.Default;
                case Accessibility.Private:
                    // A `private` static member of a `static class` that ALSO
                    // declares extension methods becomes unreachable once those
                    // methods are lifted to top-level `func`s (ADR-0115 §B.5): the
                    // lifted func qualifies the sibling reference through the owning
                    // type (`Owner.Helper`), but G# accessibility then treats the
                    // former class-private member as inaccessible (GS0472). Widen it
                    // to the position default so the qualified reference still binds
                    // (a private helper of a static utility class is an internal
                    // implementation detail with no external callers to over-expose).
                    if (!preserveStaticClassPrivate && IsMemberOfExtensionBearingStaticClass(symbol))
                    {
                        return Visibility.Default;
                    }

                    return Visibility.Private;
                case Accessibility.Internal:
                    return Visibility.Internal;
                case Accessibility.Protected:
                    // Issue #950: G# now has a first-class `protected` modifier
                    // (CIL family). It is only valid on members of an `open`
                    // class; the translator emits `open` on translatable
                    // non-sealed classes so this maps cleanly.
                    return Visibility.Protected;
                case Accessibility.ProtectedOrInternal:
                case Accessibility.ProtectedAndInternal:
                    // `protected internal` (family-or-assembly) and
                    // `private protected` (family-and-assembly) have no single
                    // G# spelling; map to the nearest accessibility 'internal'.
                    context.Report(new TranslationDiagnostic(
                        symbol.DeclaredAccessibility.ToString(),
                        $"'{symbol.Name}' is '{symbol.DeclaredAccessibility}'; G# has no combined 'protected internal'/'private protected' spelling, mapped to the nearest accessibility 'internal' (ADR-0115 §B.10).",
                        node?.GetLocation(),
                        TranslationSeverity.Warning));
                    return Visibility.Internal;
                default:
                    return Visibility.Default;
            }
        }

        /// <summary>
        /// Returns <see langword="true"/> when <paramref name="symbol"/> is a member
        /// of a <c>static class</c> that also declares at least one extension method.
        /// Such a class is decomposed at translation time — its extension methods are
        /// lifted to top-level receiver-clause <c>func</c>s (ADR-0115 §B.5) — so any
        /// sibling <c>private</c> member the lifted funcs reference must be widened to
        /// stay reachable across the resulting file scope (would otherwise be GS0472).
        /// </summary>
        private static bool IsMemberOfExtensionBearingStaticClass(ISymbol symbol)
        {
            if (symbol.ContainingType is not { IsStatic: true, TypeKind: TypeKind.Class } container)
            {
                return false;
            }

            foreach (ISymbol member in container.GetMembers())
            {
                if (member is IMethodSymbol { IsExtensionMethod: true })
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #950: returns <see langword="true"/> when <paramref name="type"/>
        /// declares any member with a <c>protected</c>-family accessibility.
        /// Such a class is intended for inheritance, so it must be emitted as an
        /// <c>open class</c> for the G# <c>protected</c> modifier to be valid.
        /// </summary>
        private static bool HasProtectedMember(INamedTypeSymbol type)
        {
            foreach (var member in type.GetMembers())
            {
                switch (member.DeclaredAccessibility)
                {
                    case Accessibility.Protected:
                    case Accessibility.ProtectedOrInternal:
                    case Accessibility.ProtectedAndInternal:
                        return true;
                }
            }

            return false;
        }

        private static HashSet<INamedTypeSymbol> CollectEfEntityTypes(CSharpCompilation compilation)
        {
            var entities = new HashSet<INamedTypeSymbol>(SymbolEqualityComparer.Default);
            foreach (SyntaxTree tree in compilation.SyntaxTrees)
            {
                SemanticModel model = compilation.GetSemanticModel(tree);
                foreach (PropertyDeclarationSyntax property in tree.GetRoot().DescendantNodes().OfType<PropertyDeclarationSyntax>())
                {
                    var dbSet = model.GetDeclaredSymbol(property)?.Type as INamedTypeSymbol;
                    if (dbSet?.Name != "DbSet"
                        || dbSet.Arity != 1
                        || dbSet.ContainingNamespace?.ToDisplayString() != "Microsoft.EntityFrameworkCore"
                        || dbSet.TypeArguments[0] is not INamedTypeSymbol entity)
                    {
                        continue;
                    }

                    entities.Add(entity.OriginalDefinition);
                }
            }

            return entities;
        }

        /// <summary>
        /// Determines whether <paramref name="type"/> will be emitted as an
        /// <c>open class</c> in G#. Mirrors the class-declaration openness logic in
        /// <see cref="VisitAggregate"/> so member-level <c>open</c> is only emitted
        /// when the enclosing class is itself open (otherwise GS0190).
        /// </summary>
        private bool IsTypeEmittedOpen(INamedTypeSymbol type)
        {
            if (type == null || type.TypeKind != TypeKind.Class || type.IsStatic)
            {
                return false;
            }

            if (type.IsAbstract
                || HasProtectedMember(type)
                || this.efEntityTypes.Contains(type.OriginalDefinition))
            {
                return true;
            }

            return !type.IsSealed && this.subclassedBases.Contains(type.OriginalDefinition);
        }

        /// <summary>
        /// Issue #1745: whether a method/property/indexer <paramref name="symbol"/>
        /// is emitted with the G# <c>open</c> modifier. Extracted from three
        /// byte-identical copies (method, property, and indexer translation) so a
        /// change to the openness rule only needs to be made once.
        /// </summary>
        /// <param name="symbol">The member symbol, or <see langword="null"/> when translating without semantic info.</param>
        /// <param name="isOverride">Whether the member is emitted with the G# <c>override</c> modifier.</param>
        /// <returns><c>true</c> when the member should carry <c>open</c>.</returns>
        private bool IsMemberEmittedOpen(ISymbol symbol, bool isOverride)
        {
            bool inInterface = symbol?.ContainingType?.TypeKind == TypeKind.Interface;
            return symbol != null && !inInterface && !symbol.IsSealed &&
                (symbol.IsVirtual || symbol.IsAbstract || isOverride) &&
                this.IsTypeEmittedOpen(symbol.ContainingType);
        }

        private static TypeDeclarationKind? MapAggregateKind(BaseTypeDeclarationSyntax node)
        {
            switch (node)
            {
                case ClassDeclarationSyntax:
                    return TypeDeclarationKind.Class;
                case StructDeclarationSyntax:
                    return TypeDeclarationKind.Struct;
                case InterfaceDeclarationSyntax:
                    return TypeDeclarationKind.Interface;
                case RecordDeclarationSyntax record:
                    return record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword)
                        ? TypeDeclarationKind.DataStruct
                        : TypeDeclarationKind.DataClass;
                default:
                    return null;
            }
        }

        private static bool IsValueAggregate(TypeDeclarationKind kind) =>
            kind == TypeDeclarationKind.Struct || kind == TypeDeclarationKind.DataStruct;

        private static bool IsFieldlessRecord(RecordDeclarationSyntax record)
        {
            // Issue #2363: an explicit-but-empty positional parameter list
            // (`record Name()`) still declares positional record *shape* — it
            // is a genuine (zero-arity) primary constructor, distinct from a
            // record with no parameter list at all (`record Name;`). Only the
            // latter is truly "fieldless"; `record Name()` maps to a G# `data
            // class`/`data struct` with zero fields (now supported by gsc —
            // GS0104 no longer rejects an empty-field data type) so it must
            // NOT be downgraded to a plain class/struct merely because its
            // primary constructor happens to have zero parameters.
            bool hasPositional = record.ParameterList != null;
            bool hasDataMember = record.Members.Any(m =>
                (m is FieldDeclarationSyntax field && !field.Modifiers.Any(SyntaxKind.StaticKeyword) && !field.Modifiers.Any(SyntaxKind.ConstKeyword)) ||
                (m is PropertyDeclarationSyntax property && !property.Modifiers.Any(SyntaxKind.StaticKeyword)));
            return !hasPositional && !hasDataMember;
        }

        /// <summary>
        /// Determines whether a C# record declares an instance auto-property data
        /// member in its body (e.g. <c>public string Title { get; }</c> or
        /// <c>{ get; init; }</c>). A G# <c>data</c> type's fields come exclusively
        /// from its positional primary-constructor parameters; auto-properties are
        /// rejected (GS0189) and a body-only record has no <c>data</c> fields at all
        /// (GS0104). Such records therefore map to a plain <c>class</c>/<c>struct</c>
        /// (OD-T5).
        /// </summary>
        private static bool RecordHasAutoPropertyDataMember(RecordDeclarationSyntax record)
        {
            return record.Members.OfType<PropertyDeclarationSyntax>().Any(p =>
                !p.Modifiers.Any(SyntaxKind.StaticKeyword) &&
                p.ExpressionBody == null &&
                p.AccessorList != null &&
                p.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null) &&
                p.AccessorList.Accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration)));
        }

        /// <summary>
        /// Determines whether a property participates in a contract that requires it
        /// to remain a real property in G# — it implements an interface property or
        /// is part of an override chain (virtual/abstract/override). Such a property
        /// cannot be lifted into a primary-constructor parameter (G# primary-ctor
        /// parameters are not properties), or the contract breaks (GS0187). OD-T1.
        /// </summary>
        private static bool IsContractProperty(IPropertySymbol property)
        {
            if (property.IsVirtual || property.IsAbstract || property.IsOverride)
            {
                return true;
            }

            INamedTypeSymbol containing = property.ContainingType;
            if (containing == null)
            {
                return false;
            }

            foreach (INamedTypeSymbol iface in containing.AllInterfaces)
            {
                foreach (IPropertySymbol ifaceProperty in iface.GetMembers().OfType<IPropertySymbol>())
                {
                    ISymbol implementation = containing.FindImplementationForInterfaceMember(ifaceProperty);
                    if (SymbolEqualityComparer.Default.Equals(implementation, property))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool IsIntegral(object value) =>
            value is byte or sbyte or short or ushort or int or uint or long or ulong;

        /// <summary>
        /// Determines whether a C# property is a plain auto-property whose value
        /// is set once at construction — a get-only auto-property (<c>{ get; }</c>)
        /// or a get+init auto-property (<c>{ get; init; }</c>), body-less, no
        /// <c>set</c> accessor. Both shapes have a backing field settable only in
        /// the declaring type's constructor; they map to an init-only G#
        /// auto-property (OD-T1; issue #946 for the init-accessor case).
        /// </summary>
        private static bool IsGetOnlyAutoProperty(PropertyDeclarationSyntax prop)
        {
            if (prop.ExpressionBody != null || prop.AccessorList == null)
            {
                return false;
            }

            IReadOnlyList<AccessorDeclarationSyntax> accessors = prop.AccessorList.Accessors;
            if (accessors.Any(a => a.Body != null || a.ExpressionBody != null))
            {
                return false;
            }

            bool hasGet = accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration));
            bool hasSet = accessors.Any(a => a.IsKind(SyntaxKind.SetAccessorDeclaration));
            return hasGet && !hasSet;
        }

        /// <summary>
        /// Collects the inline initializers of get-only/get+init auto-properties
        /// (<c>public List&lt;T&gt; Items { get; } = new();</c>,
        /// <c>public string Text { get; init; } = "empty";</c>). G# has no property
        /// member initializer, so the initialization is moved into the type's
        /// <c>init(...)</c> constructor body (OD-T1). Only meaningful for a plain
        /// class/struct that keeps an explicit constructor (not a lifted primary
        /// constructor, not a record).
        /// </summary>
        private List<(string Name, GExpression Value)> CollectGetOnlyAutoPropertyInitializers(
            IReadOnlyList<MemberDeclarationSyntax> members)
        {
            var result = new List<(string Name, GExpression Value)>();
            foreach (PropertyDeclarationSyntax prop in members.OfType<PropertyDeclarationSyntax>())
            {
                if (prop.Modifiers.Any(SyntaxKind.StaticKeyword) ||
                    prop.Initializer == null ||
                    !IsGetOnlyAutoProperty(prop))
                {
                    continue;
                }

                // Issue #1910: a merged-in property from another partial part
                // lives in a different `SyntaxTree`.
                using IDisposable modelScope = this.context.UseSemanticModelFor(prop.SyntaxTree);

                var symbol = this.context.GetDeclaredSymbol(prop) as IPropertySymbol;
                if (symbol != null &&
                    (symbol.IsAbstract || symbol.ContainingType?.TypeKind == TypeKind.Interface))
                {
                    continue;
                }

                result.Add((
                    SanitizeIdentifier(prop.Identifier.Text),
                    this.TranslateNullSeamExpression(prop.Initializer.Value, symbol?.ContainingType)));
            }

            return result;
        }

        /// <summary>
        /// Determines whether a type declares a designated instance constructor —
        /// one that is non-static and does not delegate to another constructor of
        /// the same type via <c>: this(...)</c>. Such a constructor is the place
        /// into which get-only auto-property initializers are injected (OD-T1).
        /// </summary>
        private static bool HasDesignatedInstanceConstructor(IReadOnlyList<MemberDeclarationSyntax> members)
        {
            return members
                .OfType<ConstructorDeclarationSyntax>()
                .Any(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword) &&
                    (c.Initializer == null || c.Initializer.ThisOrBaseKeyword.IsKind(SyntaxKind.BaseKeyword)));
        }

        private GExpression MapConstantDefault(IParameterSymbol symbol, SyntaxNode fallbackNode) =>
            this.MapConstantValue(symbol.ExplicitDefaultValue, symbol.Type, symbol.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax() ?? fallbackNode, $"parameter '{symbol.Name}''s default value");

        /// <summary>
        /// Maps a compile-time constant <paramref name="value"/> of type
        /// <paramref name="type"/> to its G# literal expression. Shared between an
        /// optional parameter's own default (<see cref="MapConstantDefault"/>) and
        /// a call site's <c>ArgumentKind.DefaultValue</c> argument (issue #1901:
        /// <see cref="TranslateCallArguments"/> materializes a skipped default
        /// argument explicitly when the callee is invoked indirectly through a
        /// function-typed value — gsc's structural function type, unlike a named
        /// function/method symbol, carries no default to fill in on its own).
        /// </summary>
        private GExpression MapConstantValue(object value, ITypeSymbol type, SyntaxNode fallbackNode, string diagnosticSubject)
        {
            // Issue #1733: an enum-typed default (`Color c = Color.Blue`) must
            // resolve to the member reference, not the boxed underlying integer —
            // see the remarks on <see cref="MapEnumConstant"/>.
            if (value != null && type?.TypeKind == TypeKind.Enum && IsIntegral(value))
            {
                return this.MapEnumConstant(type, value, fallbackNode, diagnosticSubject);
            }

            switch (value)
            {
                case null:
                    return null;
                case bool b:
                    return new IdentifierExpression(b ? "true" : "false");
                case string s:
                    return LiteralExpression.String(s);
                case char c:
                    return LiteralExpression.Char(c.ToString());
                case double d:
                    return MapSpecialFloatConstant(d, isDouble: true) ??
                        LiteralExpression.Float(d.ToString(CultureInfo.InvariantCulture));
                case float f:
                    return MapSpecialFloatConstant(f, isDouble: false) ??
                        LiteralExpression.Float(f.ToString(CultureInfo.InvariantCulture));

                // Issue #2236: a `decimal` default (e.g. `decimal price = 1.5m`) is
                // just as much a compile-time constant as `double`/`float` — Roslyn
                // resolves it via `ExplicitDefaultValue` like any other numeric
                // default — but this switch had no `decimal` arm, so it fell to the
                // `default:` branch below, failed `IsIntegral`, and was reported as
                // "not a simple literal" even though `decimal.ToString` never uses
                // scientific notation and round-trips cleanly as a float literal.
                case decimal m:
                    return LiteralExpression.Float(m.ToString(CultureInfo.InvariantCulture));
                default:
                    return IsIntegral(value)
                        ? LiteralExpression.Int(System.Convert.ToString(value, CultureInfo.InvariantCulture))
                        : null;
            }
        }

        /// <summary>
        /// Issue #1733: <c>double</c>/<c>float</c>'s special non-finite values
        /// (<c>NaN</c>, <c>PositiveInfinity</c>, <c>NegativeInfinity</c>) have no
        /// numeric-literal spelling — <c>d.ToString(CultureInfo.InvariantCulture)</c>
        /// renders them as the bare words <c>"NaN"</c>/<c>"Infinity"</c>/
        /// <c>"-Infinity"</c>, which G# reads as unresolved identifiers. G# exposes
        /// the BCL fields directly (`System.Double.NaN`, `System.Single.NaN`, …;
        /// see <c>Issue1616FloatNaNOperatorEmitTests</c>/<c>Issue1617…</c>), so those
        /// are emitted as a fully-qualified member reference instead — qualified so
        /// the reference resolves even when the C# source has no <c>using
        /// System;</c> (a bare <c>double</c>/<c>float</c> default never requires
        /// one).
        /// </summary>
        /// <param name="value">The floating-point value.</param>
        /// <param name="isDouble">Whether <paramref name="value"/> is a <c>double</c> (vs. <c>float</c>).</param>
        /// <returns>The qualified BCL member reference, or <see langword="null"/> when <paramref name="value"/> is an ordinary finite value.</returns>
        private static GExpression MapSpecialFloatConstant(double value, bool isDouble)
        {
            string owner = isDouble ? "System.Double" : "System.Single";
            if (double.IsNaN(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "NaN");
            }

            if (double.IsPositiveInfinity(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "PositiveInfinity");
            }

            if (double.IsNegativeInfinity(value))
            {
                return new MemberAccessExpression(new IdentifierExpression(owner), "NegativeInfinity");
            }

            return null;
        }

        /// <summary>
        /// Issue #1733: resolves an enum-typed constant's boxed underlying integral
        /// value to the qualified enum-member reference(s) it represents
        /// (<c>EnumType.Member</c>), rather than the raw integer. This callsite has
        /// no G# enum-literal syntax available (it feeds a parameter default value /
        /// attribute argument position, not an enum-declaration case), so the
        /// runtime-correct spelling is always the qualified member reference — this
        /// is unrelated to whether <see cref="VisitEnumDeclaration"/> preserves
        /// explicit case values (issue #1912, fixed) since a BCL enum (e.g.
        /// <c>System.IO.FileAttributes</c>) has no G# declaration to renumber in
        /// the first place.
        /// A <c>[Flags]</c> combination (`A | B`) with no single matching member is
        /// decomposed into the OR of the matching member names; a value that
        /// matches no member (and no flag combination) has no safe G# spelling and
        /// is reported as unsupported rather than emitting a raw int that
        /// renumbering would silently corrupt.
        /// </summary>
        /// <param name="enumType">The parameter/attribute-argument's enum type.</param>
        /// <param name="rawValue">The boxed underlying integral constant value.</param>
        /// <param name="node">The C# node to anchor an unsupported diagnostic to, or <see langword="null"/> to suppress the diagnostic.</param>
        /// <param name="constructDescription">A human-readable description of the constant's origin, for the diagnostic message.</param>
        /// <returns>The member reference (or OR'd flag combination) expression, or <see langword="null"/> when no member/combination matches.</returns>
        private GExpression MapEnumConstant(ITypeSymbol enumType, object rawValue, SyntaxNode node, string constructDescription)
        {
            if (enumType is not INamedTypeSymbol { TypeKind: TypeKind.Enum } namedEnum)
            {
                return null;
            }

            string enumTypeName = this.typeMapper.Map(namedEnum, this.context, node?.GetLocation()) is NamedTypeReference typeRef
                ? typeRef.Name
                : SanitizeIdentifier(namedEnum.Name);

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
            SpecialType underlyingType = namedEnum.EnumUnderlyingType?.SpecialType ?? SpecialType.System_Int32;
            ulong target = ToEnumBitPattern(rawValue, underlyingType);

            List<IFieldSymbol> members = namedEnum.GetMembers()
                .OfType<IFieldSymbol>()
                .Where(m => m.HasConstantValue)
                .ToList();

            foreach (IFieldSymbol member in members)
            {
                if (ToEnumBitPattern(member.ConstantValue, underlyingType) == target)
                {
                    return new MemberAccessExpression(new IdentifierExpression(enumTypeName), SanitizeIdentifier(member.Name));
                }
            }

            bool isFlags = namedEnum.GetAttributes()
                .Any(a => a.AttributeClass?.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat) == "global::System.FlagsAttribute");
            if (isFlags && target != 0)
            {
                ulong remaining = target;
                GExpression combined = null;
                foreach (IFieldSymbol member in members.OrderByDescending(
                    m => ToEnumBitPattern(m.ConstantValue, underlyingType)))
                {
                    ulong memberValue = ToEnumBitPattern(member.ConstantValue, underlyingType);
                    if (memberValue == 0 || (remaining & memberValue) != memberValue)
                    {
                        continue;
                    }

                    GExpression memberExpr = new MemberAccessExpression(new IdentifierExpression(enumTypeName), SanitizeIdentifier(member.Name));
                    combined = combined == null ? memberExpr : new BinaryExpression(combined, "|", memberExpr);
                    remaining &= ~memberValue;
                }

                if (remaining == 0 && combined != null)
                {
                    return combined;
                }
            }

            if (node != null)
            {
                this.context.ReportUnsupported(
                    node,
                    $"{constructDescription} is the enum value '{System.Convert.ToString(rawValue, CultureInfo.InvariantCulture)}' of '{namedEnum.Name}', which matches no member or [Flags] combination; G# renumbers enum members by declaration order so the raw underlying integer cannot be emitted safely.");
            }

            return null;
        }

        /// <summary>
        /// Issue #1733 N2: reinterprets a boxed enum-underlying-type value as its
        /// raw 64-bit pattern so equality/bitwise comparisons never throw
        /// <see cref="System.OverflowException"/> — <c>Convert.ToInt64</c> throws for
        /// any <c>ulong</c> value above <c>long.MaxValue</c>, and a naive
        /// <c>Convert.ToUInt64</c> throws for any negative signed value. Unsigned
        /// underlying types (<c>byte</c>/<c>ushort</c>/<c>uint</c>/<c>ulong</c>)
        /// convert straight to <c>ulong</c>; signed types (<c>sbyte</c>/<c>short</c>/
        /// <c>int</c>/<c>long</c>, and any other/unknown underlying type) go through
        /// <c>long</c> first and reinterpret its two's-complement bits as
        /// <c>ulong</c> — equality and bitwise AND/OR/NOT are bit-pattern operations,
        /// so this reinterpretation is exact for both comparisons and [Flags]
        /// decomposition regardless of signedness.
        /// </summary>
        private static ulong ToEnumBitPattern(object value, SpecialType underlyingType)
        {
            return underlyingType switch
            {
                SpecialType.System_Byte or
                SpecialType.System_UInt16 or
                SpecialType.System_UInt32 or
                SpecialType.System_UInt64 => System.Convert.ToUInt64(value, CultureInfo.InvariantCulture),
                _ => unchecked((ulong)System.Convert.ToInt64(value, CultureInfo.InvariantCulture)),
            };
        }

        private GMember VisitAggregate(TypeDeclarationSyntax node)
        {
            TypeDeclarationKind? kind = MapAggregateKind(node);
            if (kind is null)
            {
                this.context.ReportUnsupported(node, $"unsupported aggregate kind '{node.Kind()}'.");
                return null;
            }

            var symbol = this.context.GetDeclaredSymbol(node) as INamedTypeSymbol;

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
            List<TypeDeclarationSyntax> otherParts = null;
            if (!this.preservePartialParts && symbol != null && this.partialTypeParts.TryGetValue(symbol, out List<TypeDeclarationSyntax> parts))
            {
                bool isPrimaryPart = parts[0].SyntaxTree == node.SyntaxTree && parts[0].Span == node.Span;
                if (!isPrimaryPart)
                {
                    return null;
                }

                otherParts = parts.Skip(1).ToList();
            }

            // Issue #1849: this aggregate gets its own null-seam synthetic-helper
            // collection/counter, saved/restored around the whole method so a
            // nested type declaration's recursive `VisitAggregate` call (below,
            // via `TranslateMember`) never leaks its helpers into this
            // (enclosing) type, and vice versa.
            List<MethodDeclaration> outerSynthHelpers = this.state.PendingSynthHelpers;
            List<MethodDeclaration> outerInstanceSynthHelpers = this.state.PendingInstanceSynthHelpers;
            int outerSynthHelperCounter = this.state.SynthHelperCounter;
            this.state.PendingSynthHelpers = new List<MethodDeclaration>();
            this.state.PendingInstanceSynthHelpers = new List<MethodDeclaration>();
            this.state.SynthHelperCounter = 0;
            try
            {
                return this.VisitAggregateCore(node, kind.Value, symbol, otherParts);
            }
            finally
            {
                this.state.PendingSynthHelpers = outerSynthHelpers;
                this.state.PendingInstanceSynthHelpers = outerInstanceSynthHelpers;
                this.state.SynthHelperCounter = outerSynthHelperCounter;
            }
        }

        private GMember VisitAggregateCore(
            TypeDeclarationSyntax node,
            TypeDeclarationKind kindValue,
            INamedTypeSymbol symbol,
            IReadOnlyList<TypeDeclarationSyntax> otherParts)
        {
            TypeDeclarationKind? kind = kindValue;

            // Issue #2228: set below when a record's body auto-property data is
            // successfully lifted to synthetic primary-constructor parameters;
            // reused after the downgrade decision as the type's `ConstructorLift`
            // so the member loop skips the now-lifted properties.
            ConstructorLift autoPropertyLift = ConstructorLift.None;

            // Preserve init-only/required record properties as properties. Mutable
            // body auto-properties may still use the existing primary-field lift,
            // but data types now admit auto-properties and zero fields, so an
            // unlifted property no longer forces a lossy plain-class downgrade.
            if ((kind == TypeDeclarationKind.DataClass || kind == TypeDeclarationKind.DataStruct) &&
                node is RecordDeclarationSyntax record)
            {
                bool hasAutoPropData = RecordHasAutoPropertyDataMember(record);
                bool hasExplicitInstanceCtor = record.Members
                    .OfType<ConstructorDeclarationSyntax>()
                    .Any(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword));

                // Issue #2228: a record whose data lives entirely in body
                // `init`/get-only auto-properties — no positional primary-ctor
                // parameters, no explicit instance constructor — still has a
                // canonical `data class`/`data struct` form: lift each such
                // auto-property into a synthetic primary-constructor parameter
                // (+ field), exactly like AnalyzeConstructorLift already does for
                // an explicit parameter-copy constructor. This keeps value
                // equality / `with` support instead of downgrading to a plain
                // class/struct (which a `with` expression then cannot target).
                if (hasAutoPropData && !hasExplicitInstanceCtor && record.ParameterList == null)
                {
                    autoPropertyLift = this.AnalyzeAutoPropertyLift(record, symbol, kind.Value);
                }
            }

            bool isStaticClass = symbol != null && symbol.IsStatic && kind == TypeDeclarationKind.Class;

            if (isStaticClass)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ClassDeclaration),
                    $"C# 'static class {node.Identifier.Text}' has no direct G# form; mapped to a class whose members are all wrapped in a 'shared {{ }}' block (ADR-0115 §B.11 / ADR-0053).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            // Issue #1910: merge in every other partial part's members (from any
            // file) so the constructor-lift/static-initializer/property-inits
            // passes below and the main member loop see the FULL member set,
            // not just this (primary) part's own `node.Members`.
            List<MemberDeclarationSyntax> mergedMembers = node.Members.ToList();
            if (otherParts != null)
            {
                foreach (TypeDeclarationSyntax part in otherParts)
                {
                    mergedMembers.AddRange(part.Members);
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
            ConstructorLift lift = autoPropertyLift != ConstructorLift.None
                ? autoPropertyLift
                : this.AnalyzeConstructorLift(node, mergedMembers, symbol, kind.Value);

            // Issues #1990/#2435: G# data structs have no explicit `init`
            // member, but a C# record-struct constructor whose complete effect is a
            // once-only set of member assignments can still be represented at
            // every call site as a struct literal. Keep the struct and omit those
            // constructor declarations; BuildObjectCreationCore resolves the
            // actual overload and replays its analyzed plan. If even one
            // constructor has logic the literal cannot preserve, diagnose the
            // whole unsupported shape explicitly rather than silently dropping
            // the type or changing value semantics via a class downgrade.
            HashSet<ConstructorDeclarationSyntax> callSiteLoweredStructConstructors = null;
            if (!lift.DropConstructor &&
                kind == TypeDeclarationKind.DataStruct &&
                mergedMembers.OfType<ConstructorDeclarationSyntax>().Any(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword)))
            {
                callSiteLoweredStructConstructors = new HashSet<ConstructorDeclarationSyntax>();
                string unsupportedConstructorReason = null;
                foreach (ConstructorDeclarationSyntax ctor in mergedMembers
                    .OfType<ConstructorDeclarationSyntax>()
                    .Where(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword)))
                {
                    using IDisposable modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree);
                    var ctorSymbol = this.context.GetDeclaredSymbol(ctor) as IMethodSymbol;
                    if (!this.TryAnalyzeStructConstructor(
                        ctorSymbol,
                        symbol,
                        out _,
                        out unsupportedConstructorReason))
                    {
                        break;
                    }

                    callSiteLoweredStructConstructors.Add(ctor);
                }

                int instanceConstructorCount = mergedMembers
                    .OfType<ConstructorDeclarationSyntax>()
                    .Count(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword));
                if (callSiteLoweredStructConstructors.Count != instanceConstructorCount)
                {
                    this.context.ReportUnsupported(
                        node,
                        $"'{node.Identifier.Text}' has no canonical G# form: it is a record struct with an instance constructor that cannot be lowered to call-site struct literals. {unsupportedConstructorReason} A G# data struct admits no explicit 'init(...)' constructor by design (ADR-0115 §B.5, §B.14; issues #1990 and #2435). Silently mapping it to a class would change value semantics to reference semantics (Equals/GetHashCode become reference-identity, default(T) becomes null, copies become aliases, storage becomes heap-allocated), so it is not auto-translated.");
                    return null;
                }

                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ConstructorDeclaration),
                    $"record struct '{node.Identifier.Text}' constructor overloads are lowered at their call sites to G# struct literals because G# data structs have no explicit 'init(...)' members (issue #2435).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
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
            IReadOnlyList<Parameter> primaryCtor = lift.DropConstructor
                ? lift.PrimaryParameters
                : this.MapPrimaryConstructor(node);
            var primaryCtorParamNames = new HashSet<string>(
                primaryCtor?.Select(p => p.Name) ?? Enumerable.Empty<string>(), StringComparer.Ordinal);

            // OD-T1: when the explicit constructor is kept (not lifted to a primary
            // constructor) and the type is a plain class/struct, get-only
            // auto-property inline initializers (`{ get; } = new();`) must move into
            // the constructor body — G# has no property member initializer.
            List<(string Name, GExpression Value)> propertyCtorInits =
                !lift.DropConstructor &&
                    (kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.Struct)
                    ? this.CollectGetOnlyAutoPropertyInitializers(mergedMembers)
                    : new List<(string Name, GExpression Value)>();

            // Issue #1729 (mode 4): staticFieldInitializers is one shared dictionary
            // reused across the whole recursive VisitAggregate walk. Snapshot the
            // keys already present (belonging to an enclosing type still being
            // processed) so that when this invocation's own entries are cleared
            // below — including after recursing into a nested type declaration,
            // which runs this same method again — only the entries this
            // invocation itself added are removed. Without this, a nested type's
            // exit would wipe the outer type's not-yet-consumed folded fields.
            var staticFieldInitializersSnapshot = new HashSet<ISymbol>(
                this.state.StaticFieldInitializers.Keys, SymbolEqualityComparer.Default);
            this.CollectStaticFieldInitializers(mergedMembers, symbol);

            var instanceMembers = new List<GMember>();
            var sharedMembers = new List<GMember>();
            foreach (MemberDeclarationSyntax member in mergedMembers)
            {
                // Issue #1910: a merged-in member from another partial part lives
                // in a different `SyntaxTree`; resolve it (and everything nested
                // inside it) through that tree's own semantic model.
                using IDisposable modelScope = this.context.UseSemanticModelFor(member.SyntaxTree);
                foreach ((GMember translated, bool isStatic) in this.TranslateMember(
                    member,
                    kind.Value,
                    lift,
                    propertyCtorInits,
                    primaryCtorParamNames,
                    callSiteLoweredStructConstructors))
                {
                    // A C# operator overload translates to a receiver-clause
                    // `func (a T) operator <op>(...)`; like every receiver-clause
                    // func it only binds at top level, so it is lifted out as a
                    // sibling regardless of whether the owning type is a value or
                    // reference aggregate (ADR-0035, sample Operators.gs; §B.5).
                    if (translated is MethodDeclaration { Receiver: not null } opMethod &&
                        opMethod.Name.StartsWith("operator ", System.StringComparison.Ordinal))
                    {
                        this.state.PendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A lifted owned-value-aggregate instance method (it carries a
                    // receiver clause) cannot live in the struct body; collect it
                    // as a top-level sibling declaration (issue #938).
                    if (IsValueAggregate(kind.Value) &&
                        !isStatic &&
                        translated is MethodDeclaration { Receiver: not null })
                    {
                        this.state.PendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A C# extension method (`this T self`) on a `static class`
                    // translates to a receiver-clause `func`; a receiver-clause
                    // func only binds at top level (its receiver is not in scope
                    // inside a `shared { }` block), so it is lifted out and the
                    // enclosing static class is dropped if nothing else remains
                    // (ADR-0115 §B.5).
                    if (isStaticClass &&
                        translated is MethodDeclaration { Receiver: not null })
                    {
                        this.state.PendingTopLevelDeclarations.Add(translated);
                        continue;
                    }

                    // A nested type declaration (`class`/`struct`/`enum`/...) maps
                    // to a directly-nested G# type member; the parser does not allow
                    // a type declaration inside a `shared { }` block, so it is always
                    // placed in the enclosing type body regardless of staticness.
                    if (translated is TypeDeclaration or EnumDeclaration or NamedDelegateDeclaration)
                    {
                        instanceMembers.Add(translated);
                        continue;
                    }

                    if (isStatic || isStaticClass)
                    {
                        sharedMembers.Add(translated);
                    }
                    else
                    {
                        instanceMembers.Add(translated);
                    }
                }
            }

            // Issue #1849: fold in any synthetic null-seam helper methods
            // synthesized while translating this aggregate's fields/properties/
            // constructors above (see `pendingSynthHelpers`) — always private
            // static, so they join the `shared { }` block alongside the type's
            // other static members.
            sharedMembers.AddRange(this.state.PendingSynthHelpers);
            instanceMembers.AddRange(this.state.PendingInstanceSynthHelpers);

            // OD-T1: if get-only auto-property initializers needed to move into a
            // constructor but the type declares no designated instance constructor,
            // synthesize a parameterless `init()` to carry them (G# has no property
            // member initializer). Reference types only — a class is the case that
            // arises in practice.
            if (propertyCtorInits.Count > 0 &&
                kind == TypeDeclarationKind.Class &&
                !HasDesignatedInstanceConstructor(mergedMembers))
            {
                var initStatements = propertyCtorInits
                    .Select(p => (GStatement)new AssignmentStatement(new IdentifierExpression(p.Name), p.Value))
                    .ToList();
                instanceMembers.Insert(0, new ConstructorDeclaration(
                    new List<Parameter>(),
                    new BlockStatement(initStatements)));
            }

            var members = new List<GMember>(instanceMembers);
            if (sharedMembers.Count > 0)
            {
                members.Add(new SharedBlock(sharedMembers));
            }

            // Issue #1729 (mode 4): remove only the entries this invocation added
            // (see snapshot above), not the whole shared dictionary — an enclosing
            // type may still have not-yet-consumed folded fields pending.
            foreach (ISymbol key in this.state.StaticFieldInitializers.Keys.ToList())
            {
                if (!staticFieldInitializersSnapshot.Contains(key))
                {
                    this.state.StaticFieldInitializers.Remove(key);
                }
            }

            // A `static class` whose every member was an extension method lifted to
            // top level has no remaining body; drop the class entirely (ADR-0115 §B.5).
            if (isStaticClass && members.Count == 0)
            {
                return null;
            }

            (GTypeReference baseType, List<GTypeReference> interfaces) = this.MapBaseClause(symbol, node, kind.Value);
            List<GExpression> baseConstructorArguments = this.MapPrimaryConstructorBaseArguments(node, baseType);
            List<TypeParameter> typeParameters = this.MapTypeParameters(symbol);

            // A class with `protected` members must be an `open class` in G#
            // (GS0380) — `protected` is meaningless on a non-inheritable type. A C#
            // `sealed` class that carries `protected override` members (it overrides
            // an abstract/virtual protected base) therefore still maps to `open`;
            // G# has no `sealed` modifier so the sealedness is dropped (ADR-0115 §B.4).
            // A C# `record` (G# `data class`) is reference-typed and may be
            // subclassed (e.g. `record Derived : Base`); like a plain class it must
            // be declared `open` in G# to permit subclassing (GS0181) or to carry a
            // `protected` member (GS0380). `data struct`/`struct`/`interface` are
            // excluded (value types are not subclassable; interfaces are open by
            // nature).
            bool isOpenableKind = kind == TypeDeclarationKind.Class
                || kind == TypeDeclarationKind.DataClass;
            bool isOpen = symbol != null &&
                isOpenableKind &&
                !symbol.IsStatic &&
                ((!symbol.IsSealed && this.subclassedBases.Contains(symbol.OriginalDefinition))
                    || HasProtectedMember(symbol)
                    || (!symbol.IsSealed && this.efEntityTypes.Contains(symbol.OriginalDefinition)));

            // G# has no `abstract` class modifier (the keyword is not recognized by
            // the parser); a C# `abstract class`/`abstract record` therefore maps to
            // an `open class`/`open data class` — subclassable but without enforced
            // non-instantiation (ADR-0115 §B.4). The abstractness is intentionally
            // dropped.
            bool wasAbstract = symbol != null && symbol.IsAbstract && isOpenableKind;
            if (wasAbstract)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ClassDeclaration),
                    $"C# 'abstract' on '{node.Identifier.Text}' is dropped; G# has no abstract-class modifier, so the type maps to an 'open class' (ADR-0115 §B.4).",
                    node.GetLocation(),
                    TranslationSeverity.Info));
            }

            // Issue #1910 (gap 1 & 2): a `partial` type's attributes/`unsafe`
            // modifier can legally sit on ANY part, not just the primary one
            // (Roslyn's `symbol.GetAttributes()` already merges them). Union in
            // every other part's `AttributeLists`/`Modifiers` so nothing
            // declared on a non-primary part is silently dropped.
            IEnumerable<AttributeListSyntax> mergedAttributeLists = otherParts == null
                ? node.AttributeLists
                : node.AttributeLists.Concat(otherParts.SelectMany(p => p.AttributeLists));
            bool isUnsafe = node.Modifiers.Any(SyntaxKind.UnsafeKeyword) ||
                (otherParts != null && otherParts.Any(p => p.Modifiers.Any(SyntaxKind.UnsafeKeyword)));

            // ADR-0145 (§C/§D): only in preserve mode does a C# `partial` modifier
            // survive onto the G# type — each part is emitted as a standalone
            // `partial` part that augments the user's type (ADR-0144). Default
            // cs2gs-migration mode always merges parts into ONE non-partial type,
            // so `isPartial` stays false there (unchanged issue #1910 output) —
            // UNLESS the project has analyzer references (issue #2215:
            // `markMergedTypePartial`), in which case the merged type still
            // keeps `partial` so gsc's own gsgen-produced part can merge into it.
            bool sourceWasPartial = node.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword)) ||
                (otherParts != null && otherParts.Any(p => p.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword))));
            bool isPartial = sourceWasPartial && (this.preservePartialParts || this.markMergedTypePartial);

            return new TypeDeclaration(
                kind.Value,
                SanitizeIdentifier(node.Identifier.Text),
                typeParameters: typeParameters,
                primaryConstructorParameters: primaryCtor,
                baseType: baseType,
                baseConstructorArguments: baseConstructorArguments,
                interfaces: interfaces,
                members: members,
                visibility: MapVisibility(symbol, this.context, node),
                isOpen: isOpen || wasAbstract,
                isAbstract: false,
                attributes: this.MapAttributes(mergedAttributeLists),
                isUnsafe: isUnsafe,
                isPartial: isPartial);
        }

        /// <summary>
        /// Analyzes a type's single instance constructor to decide the canonical
        /// G# immutable-field initialization form (ADR-0115 §B.3 / T2). A field
        /// assigned directly from a constructor parameter is lifted to a primary
        /// constructor parameter; a field assigned an expression independent of the
        /// constructor parameters becomes a field initializer; when every
        /// statement and parameter is consumed this way the explicit
        /// <c>init</c> constructor is dropped. Anything that does not fit the
        /// pattern leaves the constructor untouched (<see cref="ConstructorLift.None"/>).
        /// </summary>
        /// <summary>
        /// Issue #2228: lifts a record's body `init`/get-only auto-property data
        /// members into synthetic primary-constructor parameters (+ fields), the
        /// same target shape <see cref="AnalyzeConstructorLift"/> produces for an
        /// explicit parameter-copy constructor. Applies only when the record has
        /// no positional primary-constructor parameters and no explicit instance
        /// constructor to conflict with (checked by the caller) — every eligible
        /// auto-property becomes one primary-constructor parameter, in
        /// declaration order, with the property's inline initializer carried
        /// over as the parameter's default value. A property without an
        /// initializer receives <c>default(T)</c>, matching the value assigned
        /// by C#'s synthesized parameterless record constructor. Bails (returns
        /// <see cref="ConstructorLift.None"/>) if any auto-property participates
        /// in an interface/override contract (OD-T1): a G# primary-constructor
        /// parameter is not a property, so lifting it would break the contract
        /// (GS0187) — the caller then falls back to the plain class/struct
        /// downgrade.
        /// </summary>
        private ConstructorLift AnalyzeAutoPropertyLift(RecordDeclarationSyntax record, INamedTypeSymbol symbol, TypeDeclarationKind kind)
        {
            if (symbol == null)
            {
                return ConstructorLift.None;
            }

            List<PropertyDeclarationSyntax> eligible = record.Members
                .OfType<PropertyDeclarationSyntax>()
                .Where(p =>
                    !p.Modifiers.Any(SyntaxKind.StaticKeyword) &&
                    p.ExpressionBody == null &&
                    p.AccessorList != null &&
                    p.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null) &&
                    p.AccessorList.Accessors.Any(a => a.IsKind(SyntaxKind.GetAccessorDeclaration)))
                .ToList();

            if (eligible.Count == 0)
            {
                return ConstructorLift.None;
            }

            var primaryParameters = new List<Parameter>();
            var propertiesAsParams = new HashSet<IPropertySymbol>(SymbolEqualityComparer.Default);
            var propertiesAsBodyFields = new HashSet<IPropertySymbol>(SymbolEqualityComparer.Default);
            var bodyFieldInitializers =
                new Dictionary<IPropertySymbol, GExpression>(SymbolEqualityComparer.Default);
            foreach (PropertyDeclarationSyntax prop in eligible)
            {
                if (this.context.GetDeclaredSymbol(prop) is not IPropertySymbol propSymbol ||
                    IsContractProperty(propSymbol))
                {
                    return ConstructorLift.None;
                }

                if (propSymbol.IsRequired || propSymbol.SetMethod?.IsInitOnly == true)
                {
                    continue;
                }

                GTypeReference type = this.typeMapper.Map(propSymbol.Type, this.context, prop.Identifier.GetLocation());

                // Issue #2281: a G# optional-parameter default must be a
                // compile-time constant (GS0265) — but a C# record property
                // initializer is NOT required to be one (it is evaluated once
                // per constructed instance, exactly like a field initializer).
                // Use the semantic model (not a syntactic guess, per the
                // "never guess" rule) to tell the two shapes apart.
                if (prop.Initializer != null &&
                    !this.context.SemanticModel.GetConstantValue(prop.Initializer.Value).HasValue)
                {
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
                    if (kind == TypeDeclarationKind.DataStruct)
                    {
                        return ConstructorLift.None;
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
                    propertiesAsBodyFields.Add(propSymbol);
                    bodyFieldInitializers[propSymbol] = this.TranslateExpression(prop.Initializer.Value);
                    continue;
                }

                GExpression defaultValue = prop.Initializer != null
                    ? this.TranslateExpression(prop.Initializer.Value)
                    : new DefaultValueExpression(type);

                primaryParameters.Add(new Parameter(SanitizeIdentifier(prop.Identifier.Text), type, defaultValue: defaultValue));
                propertiesAsParams.Add(propSymbol);
            }

            if (primaryParameters.Count == 0 && propertiesAsBodyFields.Count == 0)
            {
                return ConstructorLift.None;
            }

            var reportedNames = propertiesAsParams
                .Concat(propertiesAsBodyFields)
                .Select(p => p.Name)
                .OrderBy(n => n, StringComparer.Ordinal);
            this.context.Report(new TranslationDiagnostic(
                nameof(SyntaxKind.RecordDeclaration),
                $"record '{record.Identifier.Text}' is canonicalized to a 'data class'/'data struct': body auto-property data member(s) {string.Join(", ", reportedNames)} become primary-constructor parameter fields (now public and mutable), or — for a non-constant initializer that cannot be a valid G# optional-parameter default — a plain body field carrying that initializer (ADR-0115 §B.3/§B.4, issue #2228, issue #2281).",
                record.GetLocation(),
                TranslationSeverity.Info));

            return new ConstructorLift
            {
                Constructor = null,
                DropConstructor = true,
                PrimaryParameters = primaryParameters,
                FieldsAsPrimaryParameters = new HashSet<string>(),
                PropertiesAsPrimaryParameters = propertiesAsParams,
                PropertiesAsBodyFields = propertiesAsBodyFields,
                FieldInitializers = new Dictionary<string, GExpression>(),
                BodyFieldInitializers = bodyFieldInitializers,
                ResidualInitStatements = new List<GStatement>(),
            };
        }

        private ConstructorLift AnalyzeConstructorLift(
            TypeDeclarationSyntax node,
            IReadOnlyList<MemberDeclarationSyntax> members,
            INamedTypeSymbol symbol,
            TypeDeclarationKind kind)
        {
            // Issues #2746/#2766: replacing any explicit class or plain-struct constructor with a G#
            // primary constructor changes its CLR contract. Assignment-target
            // names replace source parameter names, and private fields become
            // public. Keep both on the normal constructor/member paths.
            if (kind == TypeDeclarationKind.Class || kind == TypeDeclarationKind.Struct)
            {
                return ConstructorLift.None;
            }

            // A C# `record struct` with an explicit (non-positional) constructor
            // cannot keep an in-body `init` member: the G# parser only accepts a
            // primary constructor on a `data struct`. Such a record-struct
            // constructor is therefore lifted to the primary constructor just like
            // a plain struct/class (ADR-0115 §B.3 / issue #1024 follow-up).
            bool isRecordStructLift = kind == TypeDeclarationKind.DataStruct
                && node is RecordDeclarationSyntax { ParameterList: null };

            if (symbol == null ||
                (kind != TypeDeclarationKind.Class
                    && kind != TypeDeclarationKind.Struct
                    && !isRecordStructLift))
            {
                return ConstructorLift.None;
            }

            List<ConstructorDeclarationSyntax> instanceCtors = members
                .OfType<ConstructorDeclarationSyntax>()
                .Where(c => !c.Modifiers.Any(SyntaxKind.StaticKeyword))
                .ToList();

            // A record already owns a primary constructor, and zero or many
            // instance constructors are out of scope for the L1 canonicalization.
            // The record-struct lift above is the sole exception: it has no
            // positional primary constructor and exactly one explicit one.
            if (instanceCtors.Count != 1 || (node is RecordDeclarationSyntax && !isRecordStructLift))
            {
                return ConstructorLift.None;
            }

            ConstructorDeclarationSyntax ctor = instanceCtors[0];
            if (ctor.Body == null || ctor.Initializer != null)
            {
                return ConstructorLift.None;
            }

            // Issue #1910: the constructor may be a merged-in member from a
            // different partial part/file; resolve it (and everything it
            // references) through that tree's own semantic model.
            using IDisposable modelScope = this.context.UseSemanticModelFor(ctor.SyntaxTree);

            var ctorSymbol = this.context.GetDeclaredSymbol(ctor) as IMethodSymbol;
            if (ctorSymbol == null)
            {
                return ConstructorLift.None;
            }

            var paramToTarget =
                new Dictionary<IParameterSymbol, (string Name, ITypeSymbol Type, IPropertySymbol Property)>(
                    SymbolEqualityComparer.Default);
            var fieldInitializers = new Dictionary<string, GExpression>();
            var residualInitStatements = new List<GStatement>();

            SyntaxNode previousScope = this.state.CurrentBodyScope;
            this.state.CurrentBodyScope = ctor;
            try
            {
                foreach (StatementSyntax statement in ctor.Body.Statements)
                {
                    if (statement is not ExpressionStatementSyntax exprStatement
                        || exprStatement.Expression is not AssignmentExpressionSyntax assignment
                        || !assignment.OperatorToken.IsKind(SyntaxKind.EqualsToken))
                    {
                        return ConstructorLift.None;
                    }

                    // The assignment target is either a backing field or an
                    // auto-property (`Width = width`); both lift to a primary
                    // constructor parameter named after the member.
                    string targetName;
                    ITypeSymbol targetType;
                    IPropertySymbol targetProperty;
                    ISymbol leftSymbol = this.context.GetSymbolInfo(assignment.Left).Symbol;
                    if (leftSymbol is IFieldSymbol fieldSymbol &&
                        !fieldSymbol.IsStatic &&
                        SymbolEqualityComparer.Default.Equals(fieldSymbol.ContainingType, symbol))
                    {
                        targetName = fieldSymbol.Name;
                        targetType = fieldSymbol.Type;
                        targetProperty = null;
                    }
                    else if (leftSymbol is IPropertySymbol propertySymbol &&
                        !propertySymbol.IsStatic &&
                        SymbolEqualityComparer.Default.Equals(propertySymbol.ContainingType, symbol))
                    {
                        targetName = propertySymbol.Name;
                        targetType = propertySymbol.Type;
                        targetProperty = propertySymbol;

                        // Value types still lift because G# `struct`/`data struct`
                        // cannot carry an in-body `init` (ADR-0115 §B.3 / B.6 / T2).
                    }
                    else
                    {
                        return ConstructorLift.None;
                    }

                    // `target = ctorParam` → lift to a primary-constructor parameter.
                    if (assignment.Right is IdentifierNameSyntax rightId
                        && this.context.GetSymbolInfo(rightId).Symbol is IParameterSymbol paramSymbol
                        && SymbolEqualityComparer.Default.Equals(paramSymbol.ContainingSymbol, ctorSymbol))
                    {
                        if (paramToTarget.ContainsKey(paramSymbol))
                        {
                            return ConstructorLift.None;
                        }

                        paramToTarget[paramSymbol] = (targetName, targetType, targetProperty);
                        continue;
                    }

                    // Otherwise the RHS must be independent of the constructor
                    // parameters to become a field initializer.
                    if (this.ReferencesAnyParameter(assignment.Right, ctorSymbol))
                    {
                        return ConstructorLift.None;
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
                    if (this.ReferencesInstanceMember(assignment.Right, symbol))
                    {
                        residualInitStatements.Add(this.TranslateExpressionStatement(assignment));
                        continue;
                    }

                    // G# supports a field member initializer (`var Name T = expr`)
                    // but has no property member initializer (`prop Name T = expr`
                    // is rejected). A constant assignment to a property therefore
                    // cannot be lifted to a member initializer; keep the explicit
                    // 'init' so its body faithfully assigns the property.
                    if (targetProperty != null)
                    {
                        return ConstructorLift.None;
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
                    if (fieldInitializers.ContainsKey(targetName) ||
                        this.ContainsPotentialSideEffect(assignment.Right))
                    {
                        return ConstructorLift.None;
                    }

                    fieldInitializers[targetName] = this.TranslateExpression(assignment.Right);
                }
            }
            finally
            {
                this.state.CurrentBodyScope = previousScope;
            }

            // Every constructor parameter must be consumed by exactly one direct
            // member assignment for the constructor to drop cleanly.
            if (ctorSymbol.Parameters.Any(p => !paramToTarget.ContainsKey(p)))
            {
                return ConstructorLift.None;
            }

            // An instance-member-dependent assignment must stay in the constructor
            // body (see above). It is emitted as a synthesized parameterless
            // `init() { ... }`, which cannot coexist with a primary constructor that
            // carries parameters. When the constructor also copies parameters into
            // members, leave the whole explicit constructor intact rather than emit a
            // conflicting primary-ctor + init pair (still valid G#).
            if (residualInitStatements.Count > 0 && ctorSymbol.Parameters.Length > 0)
            {
                return ConstructorLift.None;
            }

            var primaryParameters = new List<Parameter>();
            var fieldsAsParams = new HashSet<string>();
            var propertiesAsParams = new HashSet<IPropertySymbol>(SymbolEqualityComparer.Default);
            foreach (IParameterSymbol param in ctorSymbol.Parameters)
            {
                (string Name, ITypeSymbol Type, IPropertySymbol Property) target = paramToTarget[param];
                GTypeReference type = this.typeMapper.Map(target.Type, this.context, param.Locations.FirstOrDefault());

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
                type = this.PromoteIfUsedAsNullable(type, param);
                type = this.PromoteDelegateParameterInvokedWithNull(type, param);
                GExpression liftedDefault = this.BuildOptionalParameterDefault(param, type, node);
                primaryParameters.Add(new Parameter(SanitizeIdentifier(target.Name), type, defaultValue: liftedDefault));
                if (target.Property != null)
                {
                    propertiesAsParams.Add(target.Property);
                }
                else
                {
                    fieldsAsParams.Add(target.Name);
                }
            }

            var allParamNames = fieldsAsParams
                .Concat(propertiesAsParams.Select(p => p.Name))
                .OrderBy(n => n)
                .ToList();
            if (allParamNames.Count > 0)
            {
                this.context.Report(new TranslationDiagnostic(
                    nameof(SyntaxKind.ConstructorDeclaration),
                    $"constructor on '{node.Identifier.Text}' is canonicalized to a primary constructor: parameter-sourced member(s) {string.Join(", ", allParamNames)} become primary-constructor parameter fields (now public) and the explicit 'init' is dropped (ADR-0115 §B.3 / T2).",
                    ctor.GetLocation(),
                    TranslationSeverity.Info));
            }

            return new ConstructorLift
            {
                Constructor = ctor,
                DropConstructor = true,
                PrimaryParameters = primaryParameters,
                FieldsAsPrimaryParameters = fieldsAsParams,
                PropertiesAsPrimaryParameters = propertiesAsParams,
                FieldInitializers = fieldInitializers,
                ResidualInitStatements = residualInitStatements,
            };
        }

        private bool ReferencesAnyParameter(ExpressionSyntax expression, IMethodSymbol ctorSymbol)
        {
            foreach (IdentifierNameSyntax id in expression.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            {
                if (this.context.GetSymbolInfo(id).Symbol is IParameterSymbol p
                    && SymbolEqualityComparer.Default.Equals(p.ContainingSymbol, ctorSymbol))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Determines whether <paramref name="expression"/> reads any instance
        /// member of the type under construction — an instance field, property,
        /// method or event accessed without a static qualifier, or an explicit
        /// <c>this</c>/<c>base</c> expression. Such an expression cannot be lifted
        /// into a G# field initializer (it would reference object state before the
        /// instance exists, GS0125) and must stay in the constructor body.
        /// </summary>
        private bool ReferencesInstanceMember(ExpressionSyntax expression, INamedTypeSymbol containingType)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                if (node is ThisExpressionSyntax or BaseExpressionSyntax)
                {
                    return true;
                }

                if (node is not SimpleNameSyntax name)
                {
                    continue;
                }

                // Only the leftmost name of a member-access chain (`a.B.C`) binds to
                // a member/local in the current scope; the trailing names resolve
                // against another receiver's type, so skip them.
                if (node.Parent is MemberAccessExpressionSyntax memberAccess &&
                    memberAccess.Name == node)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(name).Symbol;
                if (symbol is { IsStatic: false } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property
                        or SymbolKind.Method or SymbolKind.Event &&
                    symbol.ContainingType != null &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType))
                {
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #1729 (mode 5): determines whether hoisting <paramref name="expression"/>
        /// to a field's declaration position could change observable behavior versus
        /// leaving it in the constructor body — a method/delegate invocation or
        /// property-getter access may run arbitrary code (I/O, mutation, logging)
        /// whose order relative to other field initializers would then differ from
        /// C#'s constructor-body order. Plain reads of fields, locals, parameters,
        /// constants, and object construction (the idiomatic
        /// <c>_field = new T(...)</c> field-initializer shape, ADR-0115 §B.3 / T2)
        /// are treated as side-effect-free and remain safe to hoist.
        /// </summary>
        private bool ContainsPotentialSideEffect(ExpressionSyntax expression)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                switch (node)
                {
                    case InvocationExpressionSyntax:
                    case AwaitExpressionSyntax:
                    case AssignmentExpressionSyntax:
                    case PostfixUnaryExpressionSyntax:
                        return true;
                    case PrefixUnaryExpressionSyntax prefix
                        when prefix.IsKind(SyntaxKind.PreIncrementExpression) ||
                            prefix.IsKind(SyntaxKind.PreDecrementExpression):
                        return true;
                }

                if (node is SimpleNameSyntax name &&
                    this.context.GetSymbolInfo(name).Symbol is IPropertySymbol)
                {
                    // A property access may run an arbitrary getter body.
                    return true;
                }
            }

            return false;
        }

        /// <summary>
        /// Issue #1729 (mode 3): determines whether <paramref name="expression"/>
        /// reads any static member of <paramref name="containingType"/> (or a base
        /// of it) — a static field, property, method, or event. A folded static
        /// constructor assignment whose RHS depends on the type's own static state
        /// cannot be hoisted to its field's declaration position without risking a
        /// change to C#'s field-initializers-then-cctor evaluation order.
        /// </summary>
        private bool ReferencesStaticMemberOfType(ExpressionSyntax expression, INamedTypeSymbol containingType)
        {
            foreach (SyntaxNode node in expression.DescendantNodesAndSelf())
            {
                if (node is not SimpleNameSyntax name)
                {
                    continue;
                }

                ISymbol symbol = this.context.GetSymbolInfo(name).Symbol;
                if (symbol is { IsStatic: true } &&
                    symbol.Kind is SymbolKind.Field or SymbolKind.Property
                        or SymbolKind.Method or SymbolKind.Event &&
                    symbol.ContainingType != null &&
                    InheritsFromOrEquals(containingType, symbol.ContainingType))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool InheritsFromOrEquals(INamedTypeSymbol type, INamedTypeSymbol candidateBase)
        {
            for (INamedTypeSymbol current = type; current != null; current = current.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(current.OriginalDefinition, candidateBase.OriginalDefinition))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
