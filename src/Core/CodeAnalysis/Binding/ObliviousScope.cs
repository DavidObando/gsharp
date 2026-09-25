// <copyright file="ObliviousScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0186 §9: declaring obliviousness in G# source.
/// <para>
/// <c>T!</c> is unspellable, so a source declaration cannot write a platform
/// type. It does not need to: obliviousness is a property of a <b>scope</b>,
/// exactly as in C# (<c>&lt;Nullable&gt;</c> plus <c>#nullable</c>), rendered
/// in G#'s idiom — the compilation switch <c>--nullability=oblivious</c> plus
/// the compiler-intrinsic <c>@Oblivious</c> / <c>@NullabilityEnabled</c>
/// annotations. The nearest enclosing annotation wins; with none, the
/// compilation switch answers. So a parameter's annotation beats its
/// function's, a function's beats its type's, and any declaration-level
/// annotation beats the compilation default.
/// </para>
/// <para>
/// <b>Which positions a scope reaches.</b> ADR-0186 open question 12 is the
/// reason this is one rule applied in one place rather than a list of
/// declaration kinds. An oblivious scope makes the <em>top-level</em>
/// position of every type written inside it as the type of a slot a value
/// lives in <c>T!</c>, when that position is an unadorned reference type:
/// </para>
/// <list type="bullet">
/// <item><description>the declared type of a field, property, event,
/// parameter (including a receiver and a lambda parameter), function or
/// lambda return, local (<c>var</c>/<c>let</c>), <c>for</c>-range variable, and
/// inline <c>out</c> declaration.</description></item>
/// </list>
/// <para>
/// <b>Nested positions stay as written</b> (owner decision, 2026-09-25,
/// amending step 5's answer to open question 12): a type argument, an
/// array/slice/map/channel element, a tuple element, and a function type's
/// parameters and return keep exactly the nullability they are spelled with,
/// in declarations and in expressions alike. So <c>List[string]</c> in an
/// oblivious scope is <c>List[string]!</c>, not <c>List[string!]!</c>, and
/// <c>[]string</c> is <c>[]!string</c>. ADR-0186 §3 rule 3 gives <c>C[T]</c>
/// and <c>C[T!]</c> no conversion in either direction, so wrapping nested
/// positions made every container handed between an oblivious scope and an
/// enabled declaration an error (about 2,700 such hand-offs in the
/// self-migration corpus). Imported oblivious metadata is not affected: its
/// nested positions still read <c>T!</c> per §2.
/// </para>
/// <para>
/// The top level of a type written for any other reason is left alone,
/// because it is not a slot: a construction target, a cast, <c>as</c>,
/// <c>typeof</c>, <c>sizeof</c>, <c>default</c>, an attribute type, a type
/// alias. So is
/// the top level of a <b>test-introduced binding</b> — a type pattern, a
/// <c>catch</c> variable, an <c>if let</c> / <c>guard let</c> /
/// <c>while let</c> binding: ADR-0186 §4 is explicit that such a binding is
/// non-null because the test succeeded, not because anything was checked, so
/// <c>T!</c> there would state less than the language already knows.
/// </para>
/// <para>
/// Two places are exempt outright, nested positions included (see
/// <c>IsExempt</c>): a <b>conformance clause</b> — a base-type or interface
/// list, a generic constraint, or an explicit-interface qualifier — and the
/// signature of a <b>native-interop</b>
/// function (<c>@DllImport</c> / <c>@LibraryImport</c>).
/// </para>
/// <para>
/// The mapping goes through <see cref="ClrNullability.SymbolForState"/>, the
/// single cell of ADR-0136's table that ADR-0186 changes: <c>T!</c> in every
/// platform-types mode, and ADR-0136's <c>T?</c> under
/// <c>--nullability=enabled</c>, where nothing constructs a
/// <see cref="PlatformTypeSymbol"/>. An oblivious G# declaration therefore
/// reads, inside its own compilation, exactly as its emitted metadata reads
/// back from another one (ADR-0186 §8) — the "two readers disagreeing about
/// one declaration" defect (#3705 family 2) cannot open between them.
/// </para>
/// </summary>
internal static class ObliviousScope
{
    private static readonly ConditionalWeakTable<SyntaxTree, ScopeMap> Maps = new();

    /// <summary>
    /// Gets a value indicating whether <paramref name="annotation"/> is the
    /// compiler-intrinsic <c>@Oblivious</c> annotation. Recognised by source
    /// spelling, like <c>@SuppressDiagnostic</c>: it names no CLR type, needs
    /// no assembly reference, and is never written to metadata.
    /// </summary>
    /// <param name="annotation">The annotation to test.</param>
    /// <returns><see langword="true"/> for <c>@Oblivious</c> / <c>@ObliviousAttribute</c>.</returns>
    internal static bool IsOblivious(AnnotationSyntax annotation)
        => HasName(annotation, "Oblivious");

    /// <summary>
    /// Gets a value indicating whether <paramref name="annotation"/> is the
    /// compiler-intrinsic <c>@NullabilityEnabled</c> annotation — the inverse
    /// of <c>@Oblivious</c>, for a declaration inside an oblivious scope.
    /// </summary>
    /// <param name="annotation">The annotation to test.</param>
    /// <returns><see langword="true"/> for <c>@NullabilityEnabled</c> / <c>@NullabilityEnabledAttribute</c>.</returns>
    internal static bool IsNullabilityEnabled(AnnotationSyntax annotation)
        => HasName(annotation, "NullabilityEnabled");

    /// <summary>
    /// Gets a value indicating whether <paramref name="annotation"/> is either
    /// ADR-0186 §9 scope annotation.
    /// </summary>
    /// <param name="annotation">The annotation to test.</param>
    /// <returns><see langword="true"/> for <c>@Oblivious</c> or <c>@NullabilityEnabled</c>.</returns>
    internal static bool IsScopeAnnotation(AnnotationSyntax annotation)
        => IsOblivious(annotation) || IsNullabilityEnabled(annotation);

    /// <summary>
    /// Validates an ADR-0186 §9 scope annotation. Neither takes arguments,
    /// and a declaration carrying both says two contradictory things; each is
    /// GS9307 rather than a silent pick, because a scope annotation that does
    /// not mean what it looks like it means changes every type in its span.
    /// </summary>
    /// <param name="annotation">The annotation (already known to be a scope annotation).</param>
    /// <param name="siblings">Every annotation on the same declaration, including <paramref name="annotation"/>.</param>
    /// <param name="diagnostics">The bag to report into.</param>
    internal static void Validate(
        AnnotationSyntax annotation,
        ImmutableArray<AnnotationSyntax> siblings,
        DiagnosticBag diagnostics)
    {
        var name = IsOblivious(annotation) ? "@Oblivious" : "@NullabilityEnabled";
        if (annotation.Target != null)
        {
            diagnostics.ReportNullabilityScopeAnnotationInvalid(
                annotation.Target.Location,
                name,
                "takes no target specifier");
        }

        // An argument list at all is the error — `@Oblivious()` included —
        // since neither annotation has anything an argument could say.
        if (annotation.HasArgumentList)
        {
            diagnostics.ReportNullabilityScopeAnnotationInvalid(
                annotation.Arguments is { Count: > 0 } arguments
                    ? arguments[0].Location
                    : Invariant.Required(annotation.OpenParenthesisToken, "an argument list has an open parenthesis").Location,
                name,
                "takes no arguments");
        }

        // Report the conflict once, on the @NullabilityEnabled of the pair.
        if (IsNullabilityEnabled(annotation) && !siblings.IsDefaultOrEmpty)
        {
            foreach (var sibling in siblings)
            {
                if (IsOblivious(sibling))
                {
                    diagnostics.ReportNullabilityScopeAnnotationInvalid(
                        annotation.AtToken.Location,
                        name,
                        "cannot be combined with @Oblivious on the same declaration");
                    break;
                }
            }
        }
    }

    /// <summary>
    /// Applies ADR-0186 §9 to a type the binder has just resolved for
    /// <paramref name="clause"/>: returns the oblivious reading of
    /// <paramref name="bound"/> when the clause is a value position inside an
    /// oblivious scope, and <paramref name="bound"/> unchanged otherwise.
    /// </summary>
    /// <param name="clause">The type clause as written.</param>
    /// <param name="bound">The type resolved for it, before this rule.</param>
    /// <returns>The type the clause denotes.</returns>
    internal static TypeSymbol ApplyToClause(TypeClauseSyntax clause, TypeSymbol bound)
    {
        if (!IsValuePosition(clause) || !IsInObliviousScope(clause) || IsExempt(clause))
        {
            return bound;
        }

        return Wrap(bound);
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="node"/> lies in an
    /// oblivious scope: the nearest enclosing <c>@Oblivious</c> or
    /// <c>@NullabilityEnabled</c> answers, and with neither the compilation's
    /// <c>--nullability</c> mode does.
    /// </summary>
    /// <param name="node">The node to classify.</param>
    /// <returns><see langword="true"/> when unadorned positions there are oblivious.</returns>
    internal static bool IsInObliviousScope(SyntaxNode node)
    {
        var tree = node.SyntaxTree;
        if (tree is not null)
        {
            var map = Maps.GetValue(tree, static t => ScopeMap.Build(t));
            if (map.TryFind(node.Span.Start, out var oblivious))
            {
                return oblivious;
            }
        }

        return NullabilityOptions.SourceObliviousByDefault;
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="clause"/> is written as
    /// the type of a slot a value lives in — see the class summary for the
    /// full rule and the reasons for each exclusion.
    /// </summary>
    /// <param name="clause">The clause to classify.</param>
    /// <returns><see langword="true"/> for a value position.</returns>
    internal static bool IsValuePosition(TypeClauseSyntax clause)
    {
        return clause.Parent switch
        {
            // A nested position of a written type — a type argument, an
            // element / key / value / channel / sequence type, a tuple
            // element, a function-type parameter or return — and an explicit
            // type argument in an expression (`F[string](x)`) stay as
            // written (see the class summary).
            TypeClauseSyntax or TypeArgumentListSyntax => false,

            ParameterSyntax parameter => ReferenceEquals(parameter.Type, clause),
            FieldDeclarationSyntax field => ReferenceEquals(field.Type, clause),
            PropertyDeclarationSyntax property => ReferenceEquals(property.Type, clause),
            EventDeclarationSyntax @event => ReferenceEquals(@event.Type, clause),
            FunctionDeclarationSyntax function => ReferenceEquals(function.Type, clause),
            DelegateDeclarationSyntax @delegate => ReferenceEquals(@delegate.ReturnType, clause),
            FunctionLiteralExpressionSyntax lambda => ReferenceEquals(lambda.ReturnTypeClause, clause),
            AnonymousClassMemberInitializerSyntax member => ReferenceEquals(member.TypeClause, clause),
            VariableDeclarationSyntax variable => ReferenceEquals(variable.TypeClause, clause),
            ForRangeStatementSyntax range => ReferenceEquals(range.TypeClause, clause),
            AwaitForRangeStatementSyntax awaitRange => ReferenceEquals(awaitRange.TypeClause, clause),
            RefArgumentExpressionSyntax outDeclaration => ReferenceEquals(outDeclaration.DeclaredType, clause),

            // Deliberately not a position (base-type / interface lists and
            // constraints are additionally exempt outright — IsExempt):
            // an array literal's element type (nested), base-type /
            // interface lists, constraints, construction targets, casts, `as`, `is` and type
            // patterns, `catch`, `if let` / `guard let` / `while let`,
            // `typeof`, `sizeof`, `default`, explicit-interface qualifiers
            // (also exempt outright), attribute types, type aliases, and synthesized clauses with no
            // parent in the tree.
            _ => false,
        };
    }

    /// <summary>
    /// The oblivious reading of <paramref name="type"/>: unchanged unless it
    /// is a concrete reference type. Value types have no oblivious reading
    /// (ADR-0186 §2: there is no <c>int32!</c>), and neither does an open type
    /// parameter, whose nullability arrives with its type argument — the same
    /// exclusion ADR-0136 and ADR-0186 §2 make for imported metadata. A type
    /// that already states its nullability (<c>T?</c>) or already is
    /// <c>T!</c> is left as it is.
    /// </summary>
    /// <param name="type">The type to read obliviously.</param>
    /// <returns>The oblivious reading.</returns>
    internal static TypeSymbol Wrap(TypeSymbol type)
    {
        if (type is NullableTypeSymbol or PlatformTypeSymbol or TypeParameterSymbol
            || !Binder.IsReferenceTypeForConstraint(type))
        {
            return type;
        }

        return ClrNullability.SymbolForState(type, ClrNullabilityState.Oblivious);
    }

    /// <summary>
    /// The two places the scope rule does not reach at all, nested positions
    /// included: a conformance clause and a native-interop signature.
    /// </summary>
    /// <param name="clause">The clause to classify.</param>
    /// <returns><see langword="true"/> when the clause is exempt.</returns>
    private static bool IsExempt(TypeClauseSyntax clause)
        => IsInConformanceClause(clause) || IsInNativeInteropSignature(clause);

    /// <summary>
    /// Gets a value indicating whether <paramref name="clause"/> is written in
    /// a base-type / interface list or a generic constraint — including as a
    /// type argument inside one (<c>class Bag : IEnumerable[Item]</c>).
    /// <para>
    /// These are <em>conformance</em> relations, not slots: they say what a
    /// type is, and what an implementing member must match. ADR-0186 open
    /// question 13 already records that a conformance relation has no point
    /// at which a check could be inserted; making its arguments platform types
    /// would add nothing a check could use and would split one interface into
    /// two — an oblivious <c>IEnumerable[Item!]</c> and the
    /// <c>IEnumerable[Item]</c> every enabled caller and every inherited slot
    /// is written against. gsc also emits no nullability metadata for a base
    /// list, so another compilation reads the relation exactly as written
    /// either way. The members that implement the relation are ordinary
    /// declarations and stay oblivious; matching them to the slot reads
    /// through their platform wrappers (<c>T!</c> has <c>T</c>'s signature).
    /// </para>
    /// </summary>
    /// <param name="clause">The clause to classify.</param>
    /// <returns><see langword="true"/> inside a base list or constraint.</returns>
    private static bool IsInConformanceClause(TypeClauseSyntax clause)
    {
        SyntaxNode outermost = clause;
        SyntaxNode? node = clause.Parent;
        while (node is TypeClauseSyntax or TypeArgumentListSyntax)
        {
            outermost = node;
            node = node.Parent;
        }

        return node switch
        {
            StructDeclarationSyntax or InterfaceDeclarationSyntax or TypeParameterSyntax or AnonymousClassExpressionSyntax => true,

            // An explicit-interface qualifier (`func (IFoo[Item]) M()`) names
            // the base-list entry it implements, and is resolved against that
            // entry — so it is a conformance clause too, and must name the same
            // type the (exempt) base list does.
            FunctionDeclarationSyntax function => ReferenceEquals(function.ExplicitInterfaceType, outermost),
            PropertyDeclarationSyntax property => ReferenceEquals(property.ExplicitInterfaceType, outermost),
            EventDeclarationSyntax @event => ReferenceEquals(@event.ExplicitInterfaceType, outermost),
            _ => false,
        };
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="clause"/> is written
    /// in the signature of a native-interop function (<c>@DllImport</c> /
    /// <c>@LibraryImport</c>). Such a signature is exempt from the scope rule:
    /// its reference positions describe <em>marshalling</em>, which the
    /// P/Invoke binder and emitter classify by the exact written type (a
    /// <c>string</c> parameter marshals as a native string, a delegate return
    /// is rejected, <c>@MarshalAs</c> is validated against it), and a native
    /// signature carries no CLR nullability contract for obliviousness to
    /// describe. A nilable native reference is spelled <c>T?</c>, as it is
    /// outside an oblivious scope.
    /// </summary>
    /// <param name="clause">The clause to classify.</param>
    /// <returns><see langword="true"/> inside a native-interop signature.</returns>
    private static bool IsInNativeInteropSignature(TypeClauseSyntax clause)
    {
        for (SyntaxNode? node = clause.Parent; node is not null; node = node.Parent)
        {
            switch (node)
            {
                case FunctionDeclarationSyntax function:
                    foreach (var annotation in function.Annotations)
                    {
                        if (IsInteropAttribute(annotation, "DllImport") || IsInteropAttribute(annotation, "LibraryImport"))
                        {
                            return true;
                        }
                    }

                    return false;

                // A lambda or a block is a body, not a signature.
                case FunctionLiteralExpressionSyntax:
                case LambdaExpressionSyntax:
                case BlockStatementSyntax:
                    return false;
            }
        }

        return false;
    }

    /// <summary>
    /// Gets a value indicating whether <paramref name="annotation"/> spells
    /// the BCL interop attribute <paramref name="name"/>: bare (<c>@DllImport</c>,
    /// as a <c>System.Runtime.InteropServices</c> import brings it into scope)
    /// or fully qualified (<c>@System.Runtime.InteropServices.DllImport</c>,
    /// which the P/Invoke binder recognises by CLR identity — issue #1206). A
    /// differently-qualified name (<c>@MyInterop.DllImport</c>) is some other
    /// attribute and is not exempt.
    /// <para>
    /// This is decided by spelling rather than by the bound attribute because
    /// a declaration's type clauses are bound before, and independently of,
    /// its attributes. The one spelling it cannot tell apart is a user type
    /// named <c>DllImport</c> brought into scope unqualified, shadowing the BCL
    /// one; such a function's signature is then left as written.
    /// </para>
    /// </summary>
    private static bool IsInteropAttribute(AnnotationSyntax annotation, string name)
    {
        const string InteropNamespace = "System.Runtime.InteropServices.";
        if (HasName(annotation, name))
        {
            return true;
        }

        if (annotation.HasTypeArgumentList)
        {
            return false;
        }

        var text = annotation.GetNameText();
        return string.Equals(text, InteropNamespace + name, StringComparison.Ordinal)
            || string.Equals(text, InteropNamespace + name + "Attribute", StringComparison.Ordinal);
    }

    private static bool HasName(AnnotationSyntax annotation, string name)
    {
        if (annotation.HasTypeArgumentList)
        {
            return false;
        }

        var text = annotation.GetNameText();
        return string.Equals(text, name, StringComparison.Ordinal)
            || string.Equals(text, name + "Attribute", StringComparison.Ordinal);
    }

    /// <summary>
    /// The §9 scope annotations of one syntax tree, as spans. Built once per
    /// tree. Spans rather than a walk up <see cref="SyntaxNode.Parent"/>
    /// because a block statement's annotations are excluded from its children
    /// (ADR-0175 keeps the block's span exactly <c>{</c>..<c>}</c>), so the
    /// parent index cannot see them; <c>DiagnosticSuppressionMap</c> resolves
    /// <c>@SuppressDiagnostic</c> scopes the same way for the same reason.
    /// </summary>
    private sealed class ScopeMap
    {
        private static readonly ScopeMap Empty = new(ImmutableArray<(TextSpan Span, bool Oblivious)>.Empty);

        private readonly ImmutableArray<(TextSpan Span, bool Oblivious)> scopes;

        /// <summary>
        /// For each scope, the index of the scope immediately enclosing it, or
        /// <c>-1</c>. A lookup that misses a scope climbs this chain rather
        /// than walking back through every earlier sibling, so it costs the
        /// nesting depth, not the number of annotated declarations before it.
        /// </summary>
        private readonly ImmutableArray<int> enclosing;

        private ScopeMap(ImmutableArray<(TextSpan Span, bool Oblivious)> scopes)
        {
            this.scopes = scopes;

            // Scopes are sorted by start, and any two nest or are disjoint, so
            // one pass with a stack of open scopes finds each one's parent.
            var parents = ImmutableArray.CreateBuilder<int>(scopes.Length);
            var open = new System.Collections.Generic.Stack<int>();
            for (var i = 0; i < scopes.Length; i++)
            {
                while (open.Count > 0 && scopes[open.Peek()].Span.End <= scopes[i].Span.Start)
                {
                    open.Pop();
                }

                parents.Add(open.Count > 0 ? open.Peek() : -1);
                open.Push(i);
            }

            this.enclosing = parents.MoveToImmutable();
        }

        internal static ScopeMap Build(SyntaxTree tree)
        {
            var builder = ImmutableArray.CreateBuilder<(TextSpan Span, bool Oblivious)>();
            foreach (var node in tree.Root.DescendantNodesAndSelf())
            {
                var annotations = Analyzers.DiagnosticSuppressionMap.GetAnnotations(node);
                if (annotations.IsDefaultOrEmpty)
                {
                    continue;
                }

                bool? oblivious = null;
                foreach (var annotation in annotations)
                {
                    if (IsNullabilityEnabled(annotation))
                    {
                        // A declaration carrying both is GS9307; the enabled
                        // reading is the one that surfaces errors rather than
                        // hiding them while the author fixes it.
                        oblivious = false;
                        break;
                    }

                    if (IsOblivious(annotation))
                    {
                        oblivious = true;
                    }
                }

                if (oblivious is bool value)
                {
                    builder.Add((node.Span, value));
                }
            }

            if (builder.Count == 0)
            {
                return Empty;
            }

            // Sorted by start so a lookup can binary-search (see TryFind).
            builder.Sort(static (x, y) => x.Span.Start.CompareTo(y.Span.Start));
            return new ScopeMap(builder.ToImmutable());
        }

        /// <summary>
        /// Finds the innermost scope containing <paramref name="position"/>.
        /// Scopes come from syntax, so any two either nest or are disjoint:
        /// among the scopes that contain a position, the innermost is the one
        /// that starts last. The scopes are sorted by start, so this binary-
        /// searches for the last scope starting at or before the position,
        /// then climbs that scope's enclosing chain until one still contains
        /// the position. Every scope containing the position encloses that
        /// last-starting one (they nest), so the climb cannot skip it, and it
        /// never visits an ended sibling.
        /// </summary>
        internal bool TryFind(int position, out bool oblivious)
        {
            oblivious = false;
            var low = 0;
            var high = this.scopes.Length - 1;
            var last = -1;
            while (low <= high)
            {
                var mid = low + ((high - low) / 2);
                if (this.scopes[mid].Span.Start <= position)
                {
                    last = mid;
                    low = mid + 1;
                }
                else
                {
                    high = mid - 1;
                }
            }

            for (var i = last; i >= 0; i = this.enclosing[i])
            {
                var (span, value) = this.scopes[i];
                if (position < span.End)
                {
                    oblivious = value;
                    return true;
                }
            }

            return false;
        }
    }
}
