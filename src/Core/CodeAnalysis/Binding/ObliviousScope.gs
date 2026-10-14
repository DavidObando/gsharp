// <copyright file="ObliviousScope.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Analyzers
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Runtime.CompilerServices

/// ADR-0186 §9: declaring obliviousness in G# source.
///
/// `T!` is unspellable, so a source declaration cannot write a platform
/// type. It does not need to: obliviousness is a property of a <b>scope</b>,
/// exactly as in C# (`<Nullable>` plus `#nullable`), rendered
/// in G#'s idiom — the compilation switch `--nullability=oblivious` plus
/// the compiler-intrinsic `@Oblivious` / `@NullabilityEnabled`
/// annotations. The nearest enclosing annotation wins; with none, the
/// compilation switch answers. So a parameter's annotation beats its
/// function's, a function's beats its type's, and any declaration-level
/// annotation beats the compilation default.
///
/// <b>Which positions a scope reaches.</b> ADR-0186 open question 12 is the
/// reason this is one rule applied in one place rather than a list of
/// declaration kinds. An oblivious scope makes the <em>top-level</em>
/// position of every type written inside it as the type of a slot a value
/// lives in `T!`, when that position is an unadorned reference type:
///
/// - the declared type of a field, property, event, parameter (including a receiver and a lambda
/// parameter), function or lambda return, local (`var`/`let`), `for`-range variable, and inline `out`
/// declaration.
///
/// <b>Nested positions stay as written</b> (owner decision, 2026-09-25,
/// amending step 5's answer to open question 12): a type argument, an
/// array/slice/map/channel element, a tuple element, and a function type's
/// parameters and return keep exactly the nullability they are spelled with,
/// in declarations and in expressions alike. So `List[string]` in an
/// oblivious scope is `List[string]!`, not `List[string!]!`, and
/// `[]string` is `[]!string`. ADR-0186 §3 rule 3 gives `C[T]`
/// and `C[T!]` no conversion in either direction, so wrapping nested
/// positions made every container handed between an oblivious scope and an
/// enabled declaration an error (the ADR-0186 §9 note records the
/// measurement). Imported oblivious metadata is not affected: its
/// nested positions still read `T!` per §2.
///
/// The top level of a type written for any other reason is left alone,
/// because it is not a slot: a construction target, a cast, `as`,
/// `typeof`, `sizeof`, `default`, an attribute type, a type
/// alias. So is
/// the top level of a <b>test-introduced binding</b> — a type pattern, a
/// `catch` variable, an `if let` / `guard let` /
/// `while let` binding: ADR-0186 §4 is explicit that such a binding is
/// non-null because the test succeeded, not because anything was checked, so
/// `T!` there would state less than the language already knows.
///
/// Two places are exempt outright, nested positions included (see
/// `IsExempt`): a <b>conformance clause</b> — a base-type or interface
/// list, a generic constraint, or an explicit-interface qualifier — and the
/// signature of a <b>native-interop</b>
/// function (`@DllImport` / `@LibraryImport`).
///
/// The mapping goes through (cref:ClrNullability.SymbolForState), the
/// single cell of ADR-0136's table that ADR-0186 changes: `T!` in every
/// platform-types mode, and ADR-0136's `T?` under
/// `--nullability=enabled`, where nothing constructs a
/// (cref:PlatformTypeSymbol). An oblivious G# declaration therefore
/// reads, inside its own compilation, exactly as its emitted metadata reads
/// back from another one (ADR-0186 §8) — the "two readers disagreeing about
/// one declaration" defect (#3705 family 2) cannot open between them.
internal shared class ObliviousScope {
    /// The §9 scope annotations of one syntax tree, as spans. Built once per
    /// tree. Spans rather than a walk up (cref:SyntaxNode.Parent)
    /// because a block statement's annotations are excluded from its children
    /// (ADR-0175 keeps the block's span exactly `{`..`}`), so the
    /// parent index cannot see them; `DiagnosticSuppressionMap` resolves
    /// `@SuppressDiagnostic` scopes the same way for the same reason.
    private class ScopeMap {
        private let scopes ImmutableArray[(Span TextSpan, Oblivious bool)]

        /// For each scope, the index of the scope immediately enclosing it, or
        /// `-1`. A lookup that misses a scope climbs this chain rather
        /// than walking back through every earlier sibling, so it costs the
        /// nesting depth, not the number of annotated declarations before it.
        private let enclosing ImmutableArray[int32]

        private init(scopes ImmutableArray[(Span TextSpan, Oblivious bool)]) {
            var scopes = scopes
            this.scopes = scopes
            // Scopes are sorted by start, and any two nest or are disjoint, so
            // one pass with a stack of open scopes finds each one's parent.
            let parents = ImmutableArray.CreateBuilder[int32](scopes.Length)
            let open_ = Stack[int32]()
            for var i = 0; i < scopes.Length; i++ {
                while open_.Count > 0 && scopes[open_.Peek()].Span.End <= scopes[i].Span.Start {
                    open_.Pop()
                }
                parents.Add(
                    if open_.Count > 0 {
                        open_.Peek()
                    } else {
                        -1
                    }
                )
                open_.Push(i)
            }
            this.enclosing = parents.MoveToImmutable()
        }

        /// Finds the innermost scope containing [`position`](paramref).
        /// Scopes come from syntax, so any two either nest or are disjoint:
        /// among the scopes that contain a position, the innermost is the one
        /// that starts last. The scopes are sorted by start, so this binary-
        /// searches for the last scope starting at or before the position,
        /// then climbs that scope's enclosing chain until one still contains
        /// the position. Every scope containing the position encloses that
        /// last-starting one (they nest), so the climb cannot skip it, and it
        /// never visits an ended sibling.
        internal func TryFind(position int32, out oblivious bool) bool {
            oblivious = false
            var low = 0
            var high = this.scopes.Length - 1
            var last = -1
            while low <= high {
                let mid = low + ((high - low) / 2)
                if this.scopes[mid].Span.Start <= position {
                    last = mid
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            for var i = last; i >= 0; i = this.enclosing[i] {
                var (span, value) = this.scopes[i]
                if position < span.End {
                    oblivious = value
                    return true
                }
            }
            return false
        }

        shared {
            private let Empty ScopeMap = ScopeMap(ImmutableArray[(Span TextSpan, Oblivious bool)].Empty)

            internal func Build(tree SyntaxTree) ScopeMap {
                let builder = ImmutableArray.CreateBuilder[(Span TextSpan, Oblivious bool)]()
                for node in tree.Root.DescendantNodesAndSelf() {
                    let annotations = DiagnosticSuppressionMap.GetAnnotations(node)
                    if annotations.IsDefaultOrEmpty {
                        continue
                    }
                    var oblivious bool? = nil
                    for annotation in annotations {
                        if ObliviousScope.IsNullabilityEnabled(annotation) {
                            // A declaration carrying both is GS9307; the enabled
                            // reading is the one that surfaces errors rather than
                            // hiding them while the author fixes it.
                            oblivious = false
                            break
                        }
                        if ObliviousScope.IsOblivious(annotation) {
                            oblivious = true
                        }
                    }
                    if oblivious is bool value {
                        builder.Add((node.Span, value))
                    }
                }
                if builder.Count == 0 {
                    return Empty
                }
                // Sorted by start so a lookup can binary-search (see TryFind).
                builder.Sort(
                    (x(Span TextSpan, Oblivious bool), y(Span TextSpan, Oblivious bool)) -> x
                        .Span
                        .Start
                        .CompareTo(y.Span.Start)
                )
                return ScopeMap(builder.ToImmutable())
            }
        }
    }

    private let Maps ConditionalWeakTable[SyntaxTree, ScopeMap] = ConditionalWeakTable[SyntaxTree, ScopeMap]()

    /// Gets a value indicating whether [`annotation`](paramref) is the
    /// compiler-intrinsic `@Oblivious` annotation. Recognised by source
    /// spelling, like `@SuppressDiagnostic`: it names no CLR type, needs
    /// no assembly reference, and is never written to metadata.
    /// @param annotation The annotation to test.
    /// @returns `true` for `@Oblivious` / `@ObliviousAttribute`.
    internal func IsOblivious(annotation AnnotationSyntax) bool -> HasName(annotation, "Oblivious")

    /// Gets a value indicating whether [`annotation`](paramref) is the
    /// compiler-intrinsic `@NullabilityEnabled` annotation — the inverse
    /// of `@Oblivious`, for a declaration inside an oblivious scope.
    /// @param annotation The annotation to test.
    /// @returns `true` for `@NullabilityEnabled` / `@NullabilityEnabledAttribute`.
    internal func IsNullabilityEnabled(annotation AnnotationSyntax) bool -> HasName(annotation, "NullabilityEnabled")

    /// Gets a value indicating whether [`annotation`](paramref) is either
    /// ADR-0186 §9 scope annotation.
    /// @param annotation The annotation to test.
    /// @returns `true` for `@Oblivious` or `@NullabilityEnabled`.
    internal func IsScopeAnnotation(annotation AnnotationSyntax) bool -> IsOblivious(annotation) ||
        IsNullabilityEnabled(annotation)

    /// Validates an ADR-0186 §9 scope annotation. Neither takes arguments,
    /// and a declaration carrying both says two contradictory things; each is
    /// GS9307 rather than a silent pick, because a scope annotation that does
    /// not mean what it looks like it means changes every type in its span.
    /// @param annotation The annotation (already known to be a scope annotation).
    /// @param siblings Every annotation on the same declaration, including [`annotation`](paramref).
    /// @param diagnostics The bag to report into.
    internal func Validate(
        annotation AnnotationSyntax,
        siblings ImmutableArray[AnnotationSyntax],
        diagnostics DiagnosticBag
    ) {
        let name = if IsOblivious(annotation) {
            "@Oblivious"
        } else {
            "@NullabilityEnabled"
        }
        if annotation.Target != nil {
            diagnostics.ReportNullabilityScopeAnnotationInvalid(
                annotation.Target.Location,
                name,
                "takes no target specifier"
            )
        }
        // An argument list at all is the error — `@Oblivious()` included —
        // since neither annotation has anything an argument could say.
        if annotation.HasArgumentList {
            diagnostics.ReportNullabilityScopeAnnotationInvalid(
                if annotation.Arguments is {Count: > 0} arguments {
                    arguments[0].Location
                } else {
                    Invariant.Required(
                        annotation.OpenParenthesisToken,
                        "an argument list has an open parenthesis",
                        expression: "annotation.OpenParenthesisToken"
                    )
                        .Location
                },
                name,
                "takes no arguments"
            )
        }
        // Report the conflict once, on the @NullabilityEnabled of the pair.
        if IsNullabilityEnabled(annotation) && !siblings.IsDefaultOrEmpty {
            for sibling in siblings {
                if IsOblivious(sibling) {
                    diagnostics.ReportNullabilityScopeAnnotationInvalid(
                        annotation.AtToken.Location,
                        name,
                        "cannot be combined with @Oblivious on the same declaration"
                    )
                    break
                }
            }
        }
    }

    /// Applies ADR-0186 §9 to a type the binder has just resolved for
    /// [`clause`](paramref): returns the oblivious reading of
    /// [`bound`](paramref) when the clause is a value position inside an
    /// oblivious scope, and [`bound`](paramref) unchanged otherwise.
    /// @param clause The type clause as written.
    /// @param bound The type resolved for it, before this rule.
    /// @returns The type the clause denotes.
    internal func ApplyToClause(clause TypeClauseSyntax, bound TypeSymbol) TypeSymbol {
        if !IsValuePosition(clause) || !IsInObliviousScope(clause) || IsExempt(clause) {
            return bound
        }
        return Wrap(bound)
    }

    /// Gets a value indicating whether [`node`](paramref) lies in an
    /// oblivious scope: the nearest enclosing `@Oblivious` or
    /// `@NullabilityEnabled` answers, and with neither the compilation's
    /// `--nullability` mode does.
    /// @param node The node to classify.
    /// @returns `true` when unadorned positions there are oblivious.
    internal func IsInObliviousScope(node SyntaxNode) bool {
        let tree SyntaxTree? = node.SyntaxTree
        if tree != nil {
            let map_ = Maps.GetValue(tree, (t SyntaxTree) -> ScopeMap.Build(t))
            if map_.TryFind(node.Span.Start, out var oblivious) {
                return oblivious
            }
        }
        return NullabilityOptions.SourceObliviousByDefault
    }

    /// Gets a value indicating whether [`clause`](paramref) is written as
    /// the type of a slot a value lives in — see the class summary for the
    /// full rule and the reasons for each exclusion.
    /// @param clause The clause to classify.
    /// @returns `true` for a value position.
    internal func IsValuePosition(clause TypeClauseSyntax) bool {
        return switch clause.Parent {
            case _ is TypeClauseSyntax or _ is TypeArgumentListSyntax: false
            case parameter is ParameterSyntax: object.ReferenceEquals(parameter.Type, clause)
            case field is FieldDeclarationSyntax: object.ReferenceEquals(field.Type, clause)
            case property is PropertyDeclarationSyntax: object.ReferenceEquals(property.Type, clause)
            case event is EventDeclarationSyntax: object.ReferenceEquals(event.Type, clause)
            case function is FunctionDeclarationSyntax: object.ReferenceEquals(function.Type, clause)
            case delegate is DelegateDeclarationSyntax: object.ReferenceEquals(delegate.ReturnType, clause)
            case lambda is FunctionLiteralExpressionSyntax: object.ReferenceEquals(lambda.ReturnTypeClause, clause)
            case member is AnonymousClassMemberInitializerSyntax: object.ReferenceEquals(member.TypeClause, clause)
            case variable is VariableDeclarationSyntax: object.ReferenceEquals(variable.TypeClause, clause)
            case range_ is ForRangeStatementSyntax: object.ReferenceEquals(range_.TypeClause, clause)
            case awaitRange is AwaitForRangeStatementSyntax: object.ReferenceEquals(awaitRange.TypeClause, clause)
            case outDeclaration is RefArgumentExpressionSyntax: object.ReferenceEquals(
                outDeclaration.DeclaredType,
                clause
            )
            default: false
        }
    }

    /// The oblivious reading of [`type`](paramref): unchanged unless it
    /// is a concrete reference type. Value types have no oblivious reading
    /// (ADR-0186 §2: there is no `int32!`), and neither does an open type
    /// parameter, whose nullability arrives with its type argument — the same
    /// exclusion ADR-0136 and ADR-0186 §2 make for imported metadata. A type
    /// that already states its nullability (`T?`) or already is
    /// `T!` is left as it is.
    /// @param type The type to read obliviously.
    /// @returns The oblivious reading.
    internal func Wrap(type TypeSymbol) TypeSymbol {
        if type is NullableTypeSymbol ||
            type is PlatformTypeSymbol ||
            type is TypeParameterSymbol ||
            !Binder.IsReferenceTypeForConstraint(type) {
            return type
        }
        return ClrNullability.SymbolForState(type, ClrNullabilityState.Oblivious)
    }

    /// The two places the scope rule does not reach at all, nested positions
    /// included: a conformance clause and a native-interop signature.
    /// @param clause The clause to classify.
    /// @returns `true` when the clause is exempt.
    private func IsExempt(clause TypeClauseSyntax) bool -> IsInConformanceClause(clause) ||
        IsInNativeInteropSignature(clause)

    /// Gets a value indicating whether [`clause`](paramref) is written in
    /// a base-type / interface list or a generic constraint — including as a
    /// type argument inside one (`class Bag : IEnumerable[Item]`).
    ///
    /// These are <em>conformance</em> relations, not slots: they say what a
    /// type is, and what an implementing member must match. ADR-0186 open
    /// question 13 already records that a conformance relation has no point
    /// at which a check could be inserted; making its arguments platform types
    /// would add nothing a check could use and would split one interface into
    /// two — an oblivious `IEnumerable[Item!]` and the
    /// `IEnumerable[Item]` every enabled caller and every inherited slot
    /// is written against. gsc also emits no nullability metadata for a base
    /// list, so another compilation reads the relation exactly as written
    /// either way. The members that implement the relation are ordinary
    /// declarations and stay oblivious; matching them to the slot reads
    /// through their platform wrappers (`T!` has `T`'s signature).
    /// @param clause The clause to classify.
    /// @returns `true` inside a base list or constraint.
    private func IsInConformanceClause(clause TypeClauseSyntax) bool {
        var outermost SyntaxNode = clause
        var node SyntaxNode? = clause.Parent
        while (node is TypeClauseSyntax or TypeArgumentListSyntax) {
            outermost = node!!
            node = node!!.Parent
        }
        return switch node {
            case _ is StructDeclarationSyntax or
                _ is InterfaceDeclarationSyntax or
                _ is TypeParameterSyntax or
                _ is AnonymousClassExpressionSyntax: true
            case function is FunctionDeclarationSyntax: object.ReferenceEquals(
                function.ExplicitInterfaceType,
                outermost
            )
            case property is PropertyDeclarationSyntax: object.ReferenceEquals(
                property.ExplicitInterfaceType,
                outermost
            )
            case event is EventDeclarationSyntax: object.ReferenceEquals(event.ExplicitInterfaceType, outermost)
            default: false
        }
    }

    /// Gets a value indicating whether [`clause`](paramref) is written
    /// in the signature of a native-interop function (`@DllImport` /
    /// `@LibraryImport`). Such a signature is exempt from the scope rule:
    /// its reference positions describe <em>marshalling</em>, which the
    /// P/Invoke binder and emitter classify by the exact written type (a
    /// `string` parameter marshals as a native string, a delegate return
    /// is rejected, `@MarshalAs` is validated against it), and a native
    /// signature carries no CLR nullability contract for obliviousness to
    /// describe. A nilable native reference is spelled `T?`, as it is
    /// outside an oblivious scope.
    /// @param clause The clause to classify.
    /// @returns `true` inside a native-interop signature.
    private func IsInNativeInteropSignature(clause TypeClauseSyntax) bool {
        for var node SyntaxNode? = clause.Parent; node != nil; node = node!!.Parent {
            switch node {
                case function is FunctionDeclarationSyntax {
                    for annotation in function.Annotations {
                        if IsInteropAttribute(annotation, "DllImport") ||
                            IsInteropAttribute(annotation, "LibraryImport") {
                            return true
                        }
                    }
                    return false
                }
                case FunctionLiteralExpressionSyntax, LambdaExpressionSyntax, BlockStatementSyntax {
                    return false
                }
            }
        }
        return false
    }

    /// Gets a value indicating whether [`annotation`](paramref) spells
    /// the BCL interop attribute [`name`](paramref): bare (`@DllImport`,
    /// as a `System.Runtime.InteropServices` import brings it into scope)
    /// or fully qualified (`@System.Runtime.InteropServices.DllImport`,
    /// which the P/Invoke binder recognises by CLR identity — issue #1206). A
    /// differently-qualified name (`@MyInterop.DllImport`) is some other
    /// attribute and is not exempt.
    ///
    /// This is decided by spelling rather than by the bound attribute because
    /// a declaration's type clauses are bound before, and independently of,
    /// its attributes. The one spelling it cannot tell apart is a user type
    /// named `DllImport` brought into scope unqualified, shadowing the BCL
    /// one; such a function's signature is then left as written.
    private func IsInteropAttribute(annotation AnnotationSyntax, name string) bool {
        const InteropNamespace = "System.Runtime.InteropServices."
        if HasName(annotation, name) {
            return true
        }
        if annotation.HasTypeArgumentList {
            return false
        }
        let text = annotation.GetNameText()
        return string.Equals(text, InteropNamespace + name, StringComparison.Ordinal) || string.Equals(
            text,
            InteropNamespace + name + "Attribute",
            StringComparison.Ordinal
        )
    }

    private func HasName(annotation AnnotationSyntax, name string) bool {
        if annotation.HasTypeArgumentList {
            return false
        }
        let text = annotation.GetNameText()
        return string.Equals(text, name, StringComparison.Ordinal) || string.Equals(
            text,
            name + "Attribute",
            StringComparison.Ordinal
        )
    }
}
