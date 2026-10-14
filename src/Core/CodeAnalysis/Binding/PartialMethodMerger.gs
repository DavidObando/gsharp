// <copyright file="PartialMethodMerger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Text

/// ADR-0192 / issue #4301: collapses the <em>declaring</em> and
/// <em>implementing</em> parts of each `partial func` into a single
/// (cref:FunctionDeclarationSyntax), so the rest of the compiler sees one
/// ordinary method.
///
/// This is the member-level analogue of (cref:PartialTypeMerger), and it
/// runs immediately after it, over the declarations that pre-pass returns. The
/// division of labour is what makes the feature cheap: ADR-0144's type merge has
/// already concatenated every part's member list into one node, so the two parts
/// of a partial method — which may come from different files — are simply two
/// entries in the same `Methods` (or `SharedBlock.Methods`) array by
/// the time this runs. Collapsing them to one entry means the ~2 000-line body
/// binder, every `Set*` installer, `FunctionSymbol`, and the emitter
/// are untouched: one node yields one symbol yields one MethodDef.
///
/// The merged node is built from the <strong>implementing</strong> part, so its
/// (cref:SyntaxNode.SyntaxTree) — and therefore the file-scoped import
/// scope its body and signature bind in — is the implementing part's file. The
/// declaring part contributes its annotations (whose own child nodes retain
/// their own tree, so they bind against the declaring file's imports, exactly as
/// ADR-0144 §E establishes for composed children) and any modifier it alone
/// states.
internal shared class PartialMethodMerger {
    /// The identity of a partial method for grouping purposes: its name, its
    /// generic arity, and its parameter TYPES. Parameter types are part of the
    /// key because two partial methods of the same name may be distinct
    /// overloads — `partial func F(x int32);` and
    /// `partial func F(x string) { … }` are two unmatched declarations, not
    /// one mismatched pair, and keying on the name alone would pair them and
    /// then report a signature conflict the user never wrote.
    private struct MethodKey : IEquatable[MethodKey] {
        private init(name string, arity int32, parameterTypes string) {
            Name = name
            Arity = arity
            ParameterTypes = parameterTypes
        }

        private prop Name string {
            get;
        }

        private prop Arity int32 {
            get;
        }

        private prop ParameterTypes string {
            get;
        }

        func Equals(other MethodKey) bool -> string.Equals(Name, other.Name, StringComparison.Ordinal) &&
            Arity == other.Arity &&
            string.Equals(ParameterTypes, other.ParameterTypes, StringComparison.Ordinal)

        override func Equals(obj object?) bool -> obj is MethodKey other && Equals(other)

        override func GetHashCode() int32 -> HashCode.Combine(Name, Arity, ParameterTypes)

        shared {
            func For(method FunctionDeclarationSyntax) MethodKey {
                // A generic method's own type parameters are positional, not
                // nominal, for the purpose of deciding WHICH method this is:
                // `Echo[T](value T)` and `Echo[U](value U)` are two parts of the
                // same method, and their differing spellings are a GS0611
                // consistency error — not two unrelated declarations. Substituting
                // `!0`, `!1`, … for the declaration's own type-parameter names
                // before hashing lets them group so that diagnostic can fire.
                // ValueText, because `$T` and `T` are the same name (ADR-0170).
                let typeParameterNames = method
                    .TypeParameterList
                    ?.Parameters
                    .Select((parameter TypeParameterSyntax) -> parameter.Identifier.ValueText ?? string.Empty)
                    .Where((text string) -> text.Length > 0)
                    .ToList()
                // The type clause alone is NOT the parameter's overload identity.
                // `F(x int32)` and `F(ref x int32)` are distinct overloads —
                // BoundScope.FunctionSignaturesEqual treats ref-kind as part of a
                // signature — and a variadic `xs ...int32` binds to a different
                // effective type (`[]int32`) than a scalar `int32` while sharing
                // the same type-clause text. Both must therefore join the key, or
                // two unrelated overloads hash together and land in one group that
                // then reports a part-count error the user never caused.
                // `scoped` is deliberately excluded: it constrains lifetime, not
                // the signature, so it is a GS0611 consistency aspect (the whole
                // parameter's text is compared there) rather than an identity one.
                let parameterTypes = string.Join(
                    ",",
                    method.Parameters.Select(
                        (parameter ParameterSyntax) -> {
                            let refKind = parameter.RefKindModifier?.Text ?? string.Empty
                            let variadic = if parameter.IsVariadic {
                                "..."
                            } else {
                                string.Empty
                            }
                            let type = TypeKey(parameter.Type, typeParameterNames)
                            return "$refKind $variadic$type"
                        }
                    )
                )
                // ADR-0170: `$F` and `F` are equivalent spellings of the same
                // identifier — the binder consistently declares methods with
                // `Identifier.ValueText`, never the verbatim `Text` (which keeps
                // the `$`). Using `Text` here would split a declaring `partial
                // func $F();` and an implementing `partial func F() { … }` into
                // two unmatched, unrelated groups instead of pairing them
                // (Copilot review round 6).
                return MethodKey(
                    method.Identifier.ValueText ?? string.Empty,
                    method.TypeParameterList?.Parameters.Count ?? 0,
                    parameterTypes
                )
            }

            /// Builds the grouping-key form of a parameter's type clause: each leaf
            /// token's kind and text, with identifier tokens compared by
            /// `ValueText` (ADR-0170) and every reference to one of the
            /// method's own type parameters replaced by its position (`!0`,
            /// `!1`, …).
            ///
            /// Works on tokens, not source text: a raw-text scan rewrote any matching
            /// word, including the member segment of a qualified name, so
            /// `F[T](x Types.T)` and `F[U](x Types.U)` both keyed their
            /// parameter as `Types.!0` and two distinct overloads collapsed
            /// into one group (Copilot review round 11). A qualifier's member
            /// segments ((cref:TypeClauseSyntax.QualifierIdentifierTokens))
            /// name a member of the qualifier, never the method's own type
            /// parameter, so they are left as written.
            private func TypeKey(type TypeClauseSyntax?, typeParameterNames List[string]?) string {
                if type == nil {
                    return string.Empty
                }
                let builder = StringBuilder()
                let qualifierMembers = HashSet[SyntaxToken](ReferenceEqualityComparer.Instance)
                AppendTypeKey(type, typeParameterNames, qualifierMembers, builder)
                return builder.ToString()
            }

            private func AppendTypeKey(
                node SyntaxNode,
                typeParameterNames List[string]?,
                qualifierMembers HashSet[SyntaxToken],
                builder StringBuilder
            ) {
                if node is TypeClauseSyntax{QualifierIdentifierTokens: {IsDefaultOrEmpty: false}} qualified {
                    qualifierMembers.UnionWith(qualified.QualifierIdentifierTokens)
                }
                if node is SyntaxToken token {
                    var text = token.Text
                    if token.Kind == SyntaxKind.IdentifierToken {
                        text = token.ValueText
                        let position = if qualifierMembers.Contains(token) {
                            -1
                        } else {
                            typeParameterNames?.IndexOf(text) ?? -1
                        }
                        if position >= 0 {
                            text = "!" + position.ToString(CultureInfo.InvariantCulture)
                        }
                    }
                    builder.Append(int32(token.Kind)).Append('\u0001').Append(text).Append('\u0002')
                    return
                }
                for child in node.GetChildren() {
                    AppendTypeKey(child, typeParameterNames, qualifierMembers, builder)
                }
            }
        }
    }

    /// Returns [`declaration`](paramref) with every partial method's parts
    /// collapsed, recursing into nested types. Never mutates its input: when
    /// anything merges it returns a copy ((cref:StructDeclarationSyntax.WithMemberLists)),
    /// otherwise the same instance. The parsed tree is reused across
    /// compilations (the language server keeps unchanged trees for full
    /// rebuilds), so each bind must start from the original parts; an earlier
    /// in-place version left merged nodes and recovery markers in the tree
    /// that later compilations then misread (Copilot review rounds 5-11).
    /// @param declaration The (possibly already type-merged) class/struct declaration.
    /// @param diagnostics The bag that receives GS0608-GS0611.
    /// @returns The normalized declaration.
    func Normalize(declaration StructDeclarationSyntax, diagnostics DiagnosticBag) StructDeclarationSyntax {
        let methods = if declaration.Methods.IsDefaultOrEmpty {
            declaration.Methods
        } else {
            MergeMethodList(declaration.Methods, declaration.IsPartial, diagnostics)
        }
        var sharedBlock = declaration.SharedBlock
        if sharedBlock is {} shared && !shared.Methods.IsDefaultOrEmpty {
            let mergedStatic = MergeMethodList(shared.Methods, declaration.IsPartial, diagnostics)
            if !mergedStatic.Equals(shared.Methods) {
                sharedBlock = SharedBlockSyntax(
                    shared.SyntaxTree,
                    shared.SharedKeyword,
                    shared.OpenBraceToken,
                    shared.Fields,
                    shared.Properties,
                    shared.Events,
                    mergedStatic,
                    shared.InitBlocks,
                    shared.CloseBraceToken
                )
            }
        }
        var nestedTypes = declaration.NestedTypes
        if !nestedTypes.IsDefaultOrEmpty {
            var rebuilt ImmutableArray[MemberSyntax].Builder? = nil
            for var i = 0; i < nestedTypes.Length; i++ {
                if nestedTypes[i] is not StructDeclarationSyntax nested {
                    rebuilt?.Add(nestedTypes[i])
                    continue
                }
                let normalized = Normalize(nested, diagnostics)
                if rebuilt == nil && !object.ReferenceEquals(normalized, nested) {
                    rebuilt = ImmutableArray.CreateBuilder[MemberSyntax](nestedTypes.Length)
                    rebuilt.AddRange(nestedTypes, i)
                }
                rebuilt?.Add(normalized)
            }
            if rebuilt != nil {
                nestedTypes = rebuilt.MoveToImmutable()
            }
        }
        if methods.Equals(declaration.Methods) && object.ReferenceEquals(sharedBlock, declaration.SharedBlock) &&
            nestedTypes.Equals(declaration.NestedTypes) {
            return declaration
        }
        return declaration.WithMemberLists(methods, sharedBlock, nestedTypes)
    }

    /// The text GS0611 compares a node of a partial method's header by: each
    /// token's kind and text, with trivia between tokens ignored. gsgen uses it
    /// to decide whether a generated implementing part already spells its
    /// declaring part's header (ADR-0192 follow-on 2), so the two comparisons
    /// cannot drift.
    /// @param node The header node, or `null`.
    /// @returns The normalized token signature (empty for `null`).
    internal func TokenSignature(node SyntaxNode?) string -> NormalizeNodeText(node)

    /// Collapses the partial-method groups in one method list. Non-partial
    /// methods pass through in place and in source order; a merged pair takes
    /// the position of its <em>declaring</em> part, which is the position a
    /// reader of the hand-written file expects the member to occupy (and keeps
    /// emitted member order stable when the implementing part arrives from a
    /// generated file whose `@(Compile)` position MSBuild may vary —
    /// the ADR-0144 §D concern). Returns the input instance when nothing is
    /// partial; otherwise a new list. Never modifies the parts themselves.
    private func MergeMethodList(
        methods ImmutableArray[FunctionDeclarationSyntax],
        enclosingTypeIsPartial bool,
        diagnostics DiagnosticBag
    ) ImmutableArray[FunctionDeclarationSyntax] {
        if !methods.Any((m FunctionDeclarationSyntax) -> m.IsPartial) {
            return methods
        }
        let groups = List[List[FunctionDeclarationSyntax]]()
        let groupByKey = Dictionary[MethodKey, List[FunctionDeclarationSyntax]]()
        for method in methods.Where((m FunctionDeclarationSyntax) -> m.IsPartial) {
            // ADR-0192 §F: receiver-clause and explicit-interface partial
            // methods are not a supported shape. Reject them rather than
            // letting a matching pair merge (Copilot review round 13); the
            // group still merges below so the rest of the member binds without
            // a duplicate-member cascade.
            if method.Receiver != nil || method.ExplicitInterfaceType != nil {
                diagnostics.ReportPartialModifierNotValidHere(method.PartialModifier!!.Location)
            }
            let key = MethodKey.For(method)
            if !groupByKey.TryGetValue(key, out var group) {
                group = List[FunctionDeclarationSyntax]()
                groupByKey[key] = group
                groups.Add(group)
            }
            group.Add(method)
        }
        // Map each group's parts to the single node that replaces them.
        let replacementByPart = Dictionary[FunctionDeclarationSyntax, FunctionDeclarationSyntax?]()
        for group in groups {
            let name = group[0].Identifier.Text ?? string.Empty
            let declaringParts = group.Where((p FunctionDeclarationSyntax) -> !HasImplementation(p)).ToList()
            let implementingParts = group.Where(HasImplementation).ToList()
            // GS0608: a `partial func` outside a `partial class`/`partial
            // struct` is invalid regardless of its part shape, so it is checked
            // once per method before the part-count branching below — a lone
            // declaring part or a part-count mismatch in a non-partial type
            // still gets GS0608 alongside GS0609/GS0610. Anchored at the
            // declaring part when one exists, else the group's first part.
            if !enclosingTypeIsPartial {
                let anchor = if declaringParts.Count > 0 {
                    declaringParts[0]
                } else {
                    group[0]
                }
                diagnostics.ReportPartialMethodRequiresPartialType(anchor.Identifier.Location, name)
            }
            if declaringParts.Count == 1 && implementingParts.Count == 1 {
                let declaring = declaringParts[0]
                let implementing = implementingParts[0]
                // Still merges afterward rather than bailing out, so a single
                // mistake does not also cascade into GS0102 (duplicate member
                // name) from the two unmerged parts.
                let disagreement = ValidateConsistency(declaring, implementing, name, diagnostics)
                let merged = BuildMergedMethod(declaring, implementing)
                // Lets the binder's semantic signature check stand down when
                // this syntax-level check already reported GS0611.
                merged.PartsDisagreement = disagreement
                // The merged node takes the DECLARING part's slot; the
                // implementing part's slot is removed.
                replacementByPart[declaring] = merged
                replacementByPart[implementing] = nil
                continue
            }
            if declaringParts.Count == 1 && implementingParts.Count == 0 {
                // The headline G# divergence from C#: an unimplemented partial
                // method is an error, not a silently elided one (see ADR-0192).
                // Narrowed to the well-formed-but-unimplemented shape — a group
                // with TWO declaring parts is a part-count problem (GS0610), and
                // reporting "no implementation" twice would hide that.
                diagnostics.ReportPartialMethodHasNoImplementation(declaringParts[0].Identifier.Location, name)
                continue
            }
            for part in group {
                diagnostics.ReportPartialMethodPartCount(
                    part.Identifier.Location,
                    name,
                    declaringParts.Count,
                    implementingParts.Count
                )
            }
            // Error recovery: keep ONE part so callers of the method still bind
            // (no "no such member" cascade on top of the real diagnostic) and
            // drop the rest so the duplicate-overload check does not also fire.
            // Prefer an implementing part — it is the one that can be emitted.
            let survivor = if implementingParts.Count > 0 {
                implementingParts[0]
            } else {
                declaringParts[0]
            }
            for part in group {
                replacementByPart[part] = if object.ReferenceEquals(part, survivor) {
                    part
                } else {
                    default(FunctionDeclarationSyntax?)
                }
            }
        }
        if replacementByPart.Count == 0 {
            return methods
        }
        let result = ImmutableArray.CreateBuilder[FunctionDeclarationSyntax](methods.Length)
        for method in methods {
            if !replacementByPart.TryGetValue(method, out var replacement) {
                result.Add(method)
                continue
            }
            if replacement != nil {
                result.Add(replacement)
            }
        }
        return result.ToImmutable()
    }

    /// Returns `true` when [`part`](paramref) is an
    /// implementing part — one that supplies a real body. A declaring part uses
    /// the universal `;` no-body marker (ADR-0086 §1), so it is exactly the
    /// complement.
    private func HasImplementation(part FunctionDeclarationSyntax) bool -> part.Body != nil

    /// Validates that the declaring and implementing parts describe the same
    /// method, reporting GS0611 for the first aspect they disagree on and
    /// returning that aspect (or `null` when they agree) for
    /// (cref:FunctionDeclarationSyntax.PartsDisagreement).
    private func ValidateConsistency(
        declaring FunctionDeclarationSyntax,
        implementing FunctionDeclarationSyntax,
        name string,
        diagnostics DiagnosticBag
    ) string? {
        let Disagree = func (aspect string) string {
            diagnostics.ReportPartialMethodPartsDisagree(implementing.Identifier.Location, name, aspect)
            return aspect
        }
        // Return type. Compared as normalized source text, the same textual
        // convention ADR-0144 §E uses for base clauses and type-parameter
        // lists: alias spellings must match exactly (`int32` and `Int32` are a
        // mismatch). Deliberately stricter than name resolution would be, and
        // relaxable later without breaking existing code.
        if NormalizeNodeText(declaring.Type) != NormalizeNodeText(implementing.Type) {
            return Disagree("the return type")
        }
        if declaring.IsRefReturn != implementing.IsRefReturn ||
            (declaring.ReturnReadOnlyModifier != nil) != (implementing.ReturnReadOnlyModifier != nil) {
            return Disagree("the 'ref' return modifiers")
        }
        // `async`/`suspend` is part of a G# method's OBSERVABLE contract — an
        // `async func F() int32` presents `Task[int32]` to callers (ADR-0023),
        // and a `suspend func` awaits implicitly (ADR-0174 D4). C# treats
        // `async` on a partial method as an implementation detail that only the
        // implementing part states; G# cannot, because the two parts would then
        // describe different signatures. Both parts must agree.
        if declaring.IsAsync != implementing.IsAsync || declaring.IsSuspend != implementing.IsSuspend {
            return Disagree("the 'async'/'suspend' modifier")
        }
        // A conversion operator and an ordinary method can share a grouping key
        // (`operator implicit` and an escaped `$op_Implicit` have the same
        // value text), and the merge takes the implementing part's form — so
        // the two parts must agree on it (Copilot review round 12).
        if declaring.IsConversionOperator != implementing.IsConversionOperator ||
            declaring.ConversionIsExplicit != implementing.ConversionIsExplicit {
            return Disagree("the conversion-operator form")
        }
        if NormalizeNodeText(declaring.TypeParameterList) != NormalizeNodeText(implementing.TypeParameterList) {
            return Disagree("the type parameter list")
        }
        // Accessibility follows ADR-0144 §C's rule for type parts: a part may
        // omit it (the effective accessibility is whatever the other part
        // states), but two STATED modifiers must agree.
        if declaring.AccessibilityModifier is {} declaredAccess &&
            implementing.AccessibilityModifier is {} implementedAccess &&
            declaredAccess.Kind != implementedAccess.Kind {
            return Disagree("accessibility")
        }
        if declaring.IsOpen != implementing.IsOpen {
            return Disagree("the 'open' modifier")
        }
        if declaring.IsOverride != implementing.IsOverride {
            return Disagree("the 'override' modifier")
        }
        if NormalizeNodeText(declaring.ExplicitInterfaceType) != NormalizeNodeText(implementing.ExplicitInterfaceType) {
            return Disagree("the explicit-interface qualifier")
        }
        if NormalizeNodeText(declaring.Receiver) != NormalizeNodeText(implementing.Receiver) {
            return Disagree("the receiver clause")
        }
        // Parameters. The grouping key already matched parameter TYPES (that is
        // what distinguishes two overloads of the same name), so what remains to
        // check is everything else a parameter carries: its name, its
        // `ref`/`out`/`in`/`scoped`/`params` modifiers, its default value, and
        // its annotations. C# reports only a warning (CS8826) for differing
        // parameter names; G# makes it an error, because a G# caller may pass
        // the argument by name and the two parts would then disagree about the
        // method's public surface.
        let declaringParameters = declaring.Parameters
        let implementingParameters = implementing.Parameters
        if declaringParameters.Count != implementingParameters.Count {
            return Disagree("the number of parameters")
        }
        for var i = 0; i < declaringParameters.Count; i++ {
            let declaringParameter = declaringParameters[i]
            let implementingParameter = implementingParameters[i]
            if NormalizeNodeText(declaringParameter) != NormalizeNodeText(implementingParameter) {
                return Disagree(
                    "parameter ${i + 1} ('${NormalizeNodeText(declaringParameter)}' vs '${NormalizeNodeText(implementingParameter)}')"
                )
            }
        }
        return nil
    }

    /// Builds the single declaration that replaces a declaring/implementing
    /// pair. The implementing part is the template — its tree, signature tokens
    /// and body are carried over verbatim — and the declaring part contributes
    /// its annotations plus any modifier only it states.
    private func BuildMergedMethod(
        declaring FunctionDeclarationSyntax,
        implementing FunctionDeclarationSyntax
    ) FunctionDeclarationSyntax {
        let merged = FunctionDeclarationSyntax(
            implementing.SyntaxTree,
            implementing.AccessibilityModifier ?? declaring.AccessibilityModifier,
            implementing.OpenModifier ?? declaring.OpenModifier,
            implementing.OverrideModifier ?? declaring.OverrideModifier,
            implementing.AsyncModifier ?? declaring.AsyncModifier,
            implementing.FunctionKeyword,
            implementing.ReceiverOpenParenthesisToken,
            implementing.Receiver,
            implementing.ReceiverCloseParenthesisToken,
            implementing.Identifier,
            implementing.TypeParameterList,
            implementing.OpenParenthesisToken,
            implementing.Parameters,
            implementing.CloseParenthesisToken,
            implementing.Type,
            implementing.Body
        ){
            PartialModifier = implementing.PartialModifier ?? declaring.PartialModifier,
            DeclaringPart = declaring,
            ImplementingPart = implementing,
            StaticModifier = implementing.StaticModifier ?? declaring.StaticModifier,
            UnsafeModifier = implementing.UnsafeModifier ?? declaring.UnsafeModifier,
            ReturnRefModifier = implementing.ReturnRefModifier ?? declaring.ReturnRefModifier,
            ReturnReadOnlyModifier = implementing.ReturnReadOnlyModifier ?? declaring.ReturnReadOnlyModifier,
            ExplicitInterfaceOpenParenthesisToken = implementing.ExplicitInterfaceOpenParenthesisToken,
            ExplicitInterfaceType = implementing.ExplicitInterfaceType,
            ExplicitInterfaceCloseParenthesisToken = implementing.ExplicitInterfaceCloseParenthesisToken,
            RetiredExtensionKeyword = implementing.RetiredExtensionKeyword,
            IsConversionOperator = implementing.IsConversionOperator,
            ConversionIsExplicit = implementing.ConversionIsExplicit
        }
        // Attributes are the UNION of both parts, in part order with the
        // declaring part first — matching C#'s partial-method rule ("the
        // combined attributes of the defining and implementing declarations")
        // and ADR-0144 §C's annotation-union rule for type parts. This is the
        // load-bearing property for the motivating scenario: a generator-written
        // implementing part must not have to restate the `@GeneratedRegex(...)`
        // the user wrote on the declaring part, and the attribute must still
        // land on the one emitted method.
        let annotations = ImmutableArray.CreateBuilder[AnnotationSyntax]()
        if !declaring.Annotations.IsDefaultOrEmpty {
            annotations.AddRange(declaring.Annotations)
        }
        if !implementing.Annotations.IsDefaultOrEmpty {
            annotations.AddRange(implementing.Annotations)
        }
        merged.WithAnnotations(annotations.ToImmutable())
        return merged
    }

    /// Renders a node as the concatenation of its leaf tokens' own kinds and
    /// exact text, ignoring only the layout BETWEEN tokens (whitespace,
    /// comments — never modeled as syntax children, so a recursive
    /// (cref:SyntaxNode.GetChildren) walk never sees them).
    ///
    /// Deliberately NOT `PartialTypeMerger`'s raw-text-minus-whitespace
    /// convention: stripping every whitespace character from the source slice
    /// also strips whitespace INSIDE a literal token's own text, so
    /// `x string = "a b"` and `x string = "ab"` compared equal — a
    /// real default-value mismatch silently accepted (Copilot review round
    /// 5). A partial method's parameters can carry a default-value literal;
    /// a partial type's base-clause/type-parameter list cannot, which is why
    /// that convention has stayed safe for `PartialTypeMerger`'s narrower
    /// use so far and is left alone here.
    private func NormalizeNodeText(node SyntaxNode?) string {
        if node == nil {
            return string.Empty
        }
        let builder = StringBuilder()
        AppendTokenSignature(node, builder)
        return builder.ToString()
    }

    /// Recursively appends each leaf (cref:SyntaxToken)'s kind and
    /// exact text to [`builder`](paramref), delimited so that no
    /// concatenation of two tokens' text can be mistaken for a different
    /// pair (e.g. `["a", "b"]` vs `["ab"]`).
    private func AppendTokenSignature(node SyntaxNode, builder StringBuilder) {
        if node is SyntaxToken token {
            // ADR-0170 / Copilot review round 8: an identifier token's
            // ValueText strips the `$` escape marker (`$T` and `T` are the
            // same identifier) -- everywhere else in the binder compares
            // identifiers this way. Scoped to IdentifierToken specifically
            // so every OTHER token kind (crucially, a string-literal
            // token's raw quoted text) keeps the exact Text comparison
            // round 5 relied on to preserve a literal's own content.
            let text = if token.Kind == SyntaxKind.IdentifierToken {
                token.ValueText
            } else {
                token.Text
            }
            builder.Append(int32(token.Kind)).Append('\u0001').Append(text).Append('\u0002')
            return
        }
        for child in node.GetChildren() {
            AppendTokenSignature(child, builder)
        }
    }
}
