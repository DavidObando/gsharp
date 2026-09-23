// <copyright file="PartialMethodMerger.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Binding;

/// <summary>
/// ADR-0192 / issue #4301: collapses the <em>declaring</em> and
/// <em>implementing</em> parts of each <c>partial func</c> into a single
/// <see cref="FunctionDeclarationSyntax"/>, so the rest of the compiler sees one
/// ordinary method.
/// <para>
/// This is the member-level analogue of <see cref="PartialTypeMerger"/>, and it
/// runs immediately after it, over the declarations that pre-pass returns. The
/// division of labour is what makes the feature cheap: ADR-0144's type merge has
/// already concatenated every part's member list into one node, so the two parts
/// of a partial method — which may come from different files — are simply two
/// entries in the same <c>Methods</c> (or <c>SharedBlock.Methods</c>) array by
/// the time this runs. Collapsing them to one entry means the ~2 000-line body
/// binder, every <c>Set*</c> installer, <c>FunctionSymbol</c>, and the emitter
/// are untouched: one node yields one symbol yields one MethodDef.
/// </para>
/// <para>
/// The merged node is built from the <strong>implementing</strong> part, so its
/// <see cref="SyntaxNode.SyntaxTree"/> — and therefore the file-scoped import
/// scope its body and signature bind in — is the implementing part's file. The
/// declaring part contributes its annotations (whose own child nodes retain
/// their own tree, so they bind against the declaring file's imports, exactly as
/// ADR-0144 §E establishes for composed children) and any modifier it alone
/// states.
/// </para>
/// </summary>
internal static class PartialMethodMerger
{
    /// <summary>
    /// Returns <paramref name="declaration"/> with every partial method's parts
    /// collapsed, recursing into nested types. Never mutates its input: when
    /// anything merges it returns a copy (<see cref="StructDeclarationSyntax.WithMemberLists"/>),
    /// otherwise the same instance. The parsed tree is reused across
    /// compilations (the language server keeps unchanged trees for full
    /// rebuilds), so each bind must start from the original parts; an earlier
    /// in-place version left merged nodes and recovery markers in the tree
    /// that later compilations then misread (Copilot review rounds 5-11).
    /// </summary>
    /// <param name="declaration">The (possibly already type-merged) class/struct declaration.</param>
    /// <param name="diagnostics">The bag that receives GS0608-GS0611.</param>
    /// <returns>The normalized declaration.</returns>
    public static StructDeclarationSyntax Normalize(StructDeclarationSyntax declaration, DiagnosticBag diagnostics)
    {
        var methods = declaration.Methods.IsDefaultOrEmpty
            ? declaration.Methods
            : MergeMethodList(declaration.Methods, declaration.IsPartial, diagnostics);

        var sharedBlock = declaration.SharedBlock;
        if (sharedBlock is { } shared && !shared.Methods.IsDefaultOrEmpty)
        {
            var mergedStatic = MergeMethodList(shared.Methods, declaration.IsPartial, diagnostics);
            if (!mergedStatic.Equals(shared.Methods))
            {
                sharedBlock = new SharedBlockSyntax(
                    shared.SyntaxTree,
                    shared.SharedKeyword,
                    shared.OpenBraceToken,
                    shared.Fields,
                    shared.Properties,
                    shared.Events,
                    mergedStatic,
                    shared.InitBlocks,
                    shared.CloseBraceToken);
            }
        }

        var nestedTypes = declaration.NestedTypes;
        if (!nestedTypes.IsDefaultOrEmpty)
        {
            ImmutableArray<MemberSyntax>.Builder? rebuilt = null;
            for (var i = 0; i < nestedTypes.Length; i++)
            {
                if (nestedTypes[i] is not StructDeclarationSyntax nested)
                {
                    rebuilt?.Add(nestedTypes[i]);
                    continue;
                }

                var normalized = Normalize(nested, diagnostics);
                if (rebuilt == null && !ReferenceEquals(normalized, nested))
                {
                    rebuilt = ImmutableArray.CreateBuilder<MemberSyntax>(nestedTypes.Length);
                    rebuilt.AddRange(nestedTypes, i);
                }

                rebuilt?.Add(normalized);
            }

            if (rebuilt != null)
            {
                nestedTypes = rebuilt.MoveToImmutable();
            }
        }

        if (methods.Equals(declaration.Methods)
            && ReferenceEquals(sharedBlock, declaration.SharedBlock)
            && nestedTypes.Equals(declaration.NestedTypes))
        {
            return declaration;
        }

        return declaration.WithMemberLists(methods, sharedBlock, nestedTypes);
    }

    /// <summary>
    /// Collapses the partial-method groups in one method list. Non-partial
    /// methods pass through in place and in source order; a merged pair takes
    /// the position of its <em>declaring</em> part, which is the position a
    /// reader of the hand-written file expects the member to occupy (and keeps
    /// emitted member order stable when the implementing part arrives from a
    /// generated file whose <c>@(Compile)</c> position MSBuild may vary —
    /// the ADR-0144 §D concern). Returns the input instance when nothing is
    /// partial; otherwise a new list. Never modifies the parts themselves.
    /// </summary>
    private static ImmutableArray<FunctionDeclarationSyntax> MergeMethodList(
        ImmutableArray<FunctionDeclarationSyntax> methods,
        bool enclosingTypeIsPartial,
        DiagnosticBag diagnostics)
    {
        if (!methods.Any(m => m.IsPartial))
        {
            return methods;
        }

        var groups = new List<List<FunctionDeclarationSyntax>>();
        var groupByKey = new Dictionary<MethodKey, List<FunctionDeclarationSyntax>>();
        foreach (var method in methods.Where(m => m.IsPartial))
        {
            var key = MethodKey.For(method);
            if (!groupByKey.TryGetValue(key, out var group))
            {
                group = new List<FunctionDeclarationSyntax>();
                groupByKey[key] = group;
                groups.Add(group);
            }

            group.Add(method);
        }

        // Map each group's parts to the single node that replaces them.
        var replacementByPart = new Dictionary<FunctionDeclarationSyntax, FunctionDeclarationSyntax?>();
        foreach (var group in groups)
        {
            var name = group[0].Identifier.Text ?? string.Empty;
            var declaringParts = group.Where(p => !HasImplementation(p)).ToList();
            var implementingParts = group.Where(HasImplementation).ToList();

            // GS0608: a `partial func` outside a `partial class`/`partial
            // struct` is invalid regardless of its part shape, so it is checked
            // once per method before the part-count branching below — a lone
            // declaring part or a part-count mismatch in a non-partial type
            // still gets GS0608 alongside GS0609/GS0610. Anchored at the
            // declaring part when one exists, else the group's first part.
            if (!enclosingTypeIsPartial)
            {
                var anchor = declaringParts.Count > 0 ? declaringParts[0] : group[0];
                diagnostics.ReportPartialMethodRequiresPartialType(anchor.Identifier.Location, name);
            }

            if (declaringParts.Count == 1 && implementingParts.Count == 1)
            {
                var declaring = declaringParts[0];
                var implementing = implementingParts[0];

                // Still merges afterward rather than bailing out, so a single
                // mistake does not also cascade into GS0102 (duplicate member
                // name) from the two unmerged parts.
                var disagreement = ValidateConsistency(declaring, implementing, name, diagnostics);

                var merged = BuildMergedMethod(declaring, implementing);

                // Lets the binder's semantic signature check stand down when
                // this syntax-level check already reported GS0611.
                merged.PartsDisagreement = disagreement;

                // The merged node takes the DECLARING part's slot; the
                // implementing part's slot is removed.
                replacementByPart[declaring] = merged;
                replacementByPart[implementing] = null;
                continue;
            }

            if (declaringParts.Count == 1 && implementingParts.Count == 0)
            {
                // The headline G# divergence from C#: an unimplemented partial
                // method is an error, not a silently elided one (see ADR-0192).
                // Narrowed to the well-formed-but-unimplemented shape — a group
                // with TWO declaring parts is a part-count problem (GS0610), and
                // reporting "no implementation" twice would hide that.
                diagnostics.ReportPartialMethodHasNoImplementation(declaringParts[0].Identifier.Location, name);
                continue;
            }

            foreach (var part in group)
            {
                diagnostics.ReportPartialMethodPartCount(
                    part.Identifier.Location,
                    name,
                    declaringParts.Count,
                    implementingParts.Count);
            }

            // Error recovery: keep ONE part so callers of the method still bind
            // (no "no such member" cascade on top of the real diagnostic) and
            // drop the rest so the duplicate-overload check does not also fire.
            // Prefer an implementing part — it is the one that can be emitted.
            var survivor = implementingParts.Count > 0 ? implementingParts[0] : declaringParts[0];
            foreach (var part in group)
            {
                replacementByPart[part] = ReferenceEquals(part, survivor) ? part : null;
            }
        }

        if (replacementByPart.Count == 0)
        {
            return methods;
        }

        var result = ImmutableArray.CreateBuilder<FunctionDeclarationSyntax>(methods.Length);
        foreach (var method in methods)
        {
            if (!replacementByPart.TryGetValue(method, out var replacement))
            {
                result.Add(method);
                continue;
            }

            if (replacement != null)
            {
                result.Add(replacement);
            }
        }

        return result.ToImmutable();
    }

    /// <summary>
    /// Returns <see langword="true"/> when <paramref name="part"/> is an
    /// implementing part — one that supplies a real body. A declaring part uses
    /// the universal <c>;</c> no-body marker (ADR-0086 §1), so it is exactly the
    /// complement.
    /// </summary>
    private static bool HasImplementation(FunctionDeclarationSyntax part) => part.Body != null;

    /// <summary>
    /// Validates that the declaring and implementing parts describe the same
    /// method, reporting GS0611 for the first aspect they disagree on and
    /// returning that aspect (or <see langword="null"/> when they agree) for
    /// <see cref="FunctionDeclarationSyntax.PartsDisagreement"/>.
    /// </summary>
    private static string? ValidateConsistency(
        FunctionDeclarationSyntax declaring,
        FunctionDeclarationSyntax implementing,
        string name,
        DiagnosticBag diagnostics)
    {
        string Disagree(string aspect)
        {
            diagnostics.ReportPartialMethodPartsDisagree(implementing.Identifier.Location, name, aspect);
            return aspect;
        }

        // Return type. Compared as normalized source text, the same textual
        // convention ADR-0144 §E uses for base clauses and type-parameter
        // lists: alias spellings must match exactly (`int32` and `Int32` are a
        // mismatch). Deliberately stricter than name resolution would be, and
        // relaxable later without breaking existing code.
        if (NormalizeNodeText(declaring.Type) != NormalizeNodeText(implementing.Type))
        {
            return Disagree("the return type");
        }

        if (declaring.IsRefReturn != implementing.IsRefReturn
            || (declaring.ReturnReadOnlyModifier != null) != (implementing.ReturnReadOnlyModifier != null))
        {
            return Disagree("the 'ref' return modifiers");
        }

        // `async`/`suspend` is part of a G# method's OBSERVABLE contract — an
        // `async func F() int32` presents `Task[int32]` to callers (ADR-0023),
        // and a `suspend func` awaits implicitly (ADR-0174 D4). C# treats
        // `async` on a partial method as an implementation detail that only the
        // implementing part states; G# cannot, because the two parts would then
        // describe different signatures. Both parts must agree.
        if (declaring.IsAsync != implementing.IsAsync || declaring.IsSuspend != implementing.IsSuspend)
        {
            return Disagree("the 'async'/'suspend' modifier");
        }

        // A conversion operator and an ordinary method can share a grouping key
        // (`operator implicit` and an escaped `$op_Implicit` have the same
        // value text), and the merge takes the implementing part's form — so
        // the two parts must agree on it (Copilot review round 12).
        if (declaring.IsConversionOperator != implementing.IsConversionOperator
            || declaring.ConversionIsExplicit != implementing.ConversionIsExplicit)
        {
            return Disagree("the conversion-operator form");
        }

        if (NormalizeNodeText(declaring.TypeParameterList) != NormalizeNodeText(implementing.TypeParameterList))
        {
            return Disagree("the type parameter list");
        }

        // Accessibility follows ADR-0144 §C's rule for type parts: a part may
        // omit it (the effective accessibility is whatever the other part
        // states), but two STATED modifiers must agree.
        if (declaring.AccessibilityModifier is { } declaredAccess
            && implementing.AccessibilityModifier is { } implementedAccess
            && declaredAccess.Kind != implementedAccess.Kind)
        {
            return Disagree("accessibility");
        }

        if (declaring.IsOpen != implementing.IsOpen)
        {
            return Disagree("the 'open' modifier");
        }

        if (declaring.IsOverride != implementing.IsOverride)
        {
            return Disagree("the 'override' modifier");
        }

        if (NormalizeNodeText(declaring.ExplicitInterfaceType) != NormalizeNodeText(implementing.ExplicitInterfaceType))
        {
            return Disagree("the explicit-interface qualifier");
        }

        if (NormalizeNodeText(declaring.Receiver) != NormalizeNodeText(implementing.Receiver))
        {
            return Disagree("the receiver clause");
        }

        // Parameters. The grouping key already matched parameter TYPES (that is
        // what distinguishes two overloads of the same name), so what remains to
        // check is everything else a parameter carries: its name, its
        // `ref`/`out`/`in`/`scoped`/`params` modifiers, its default value, and
        // its annotations. C# reports only a warning (CS8826) for differing
        // parameter names; G# makes it an error, because a G# caller may pass
        // the argument by name and the two parts would then disagree about the
        // method's public surface.
        var declaringParameters = declaring.Parameters;
        var implementingParameters = implementing.Parameters;
        if (declaringParameters.Count != implementingParameters.Count)
        {
            return Disagree("the number of parameters");
        }

        for (var i = 0; i < declaringParameters.Count; i++)
        {
            var declaringParameter = declaringParameters[i];
            var implementingParameter = implementingParameters[i];
            if (NormalizeNodeText(declaringParameter) != NormalizeNodeText(implementingParameter))
            {
                return Disagree(
                    $"parameter {i + 1} ('{NormalizeNodeText(declaringParameter)}' vs '{NormalizeNodeText(implementingParameter)}')");
            }
        }

        return null;
    }

    /// <summary>
    /// Builds the single declaration that replaces a declaring/implementing
    /// pair. The implementing part is the template — its tree, signature tokens
    /// and body are carried over verbatim — and the declaring part contributes
    /// its annotations plus any modifier only it states.
    /// </summary>
    private static FunctionDeclarationSyntax BuildMergedMethod(
        FunctionDeclarationSyntax declaring,
        FunctionDeclarationSyntax implementing)
    {
        var merged = new FunctionDeclarationSyntax(
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
            implementing.Body)
        {
            PartialModifier = implementing.PartialModifier ?? declaring.PartialModifier,
            DeclaringPart = declaring,
            ImplementingPart = implementing,
            StaticModifier = implementing.StaticModifier ?? declaring.StaticModifier,

            // `unsafe` is per-part in ADR-0144 §C, and unioning is the only safe
            // reading here: the merged node carries ONE signature, so if either
            // part's signature was written in an unsafe context (raw `*T`
            // parameters), the merged node must bind in one too.
            UnsafeModifier = implementing.UnsafeModifier ?? declaring.UnsafeModifier,
            ReturnRefModifier = implementing.ReturnRefModifier ?? declaring.ReturnRefModifier,
            ReturnReadOnlyModifier = implementing.ReturnReadOnlyModifier ?? declaring.ReturnReadOnlyModifier,
            ExplicitInterfaceOpenParenthesisToken = implementing.ExplicitInterfaceOpenParenthesisToken,
            ExplicitInterfaceType = implementing.ExplicitInterfaceType,
            ExplicitInterfaceCloseParenthesisToken = implementing.ExplicitInterfaceCloseParenthesisToken,
            RetiredExtensionKeyword = implementing.RetiredExtensionKeyword,
            IsConversionOperator = implementing.IsConversionOperator,
            ConversionIsExplicit = implementing.ConversionIsExplicit,
        };

        // Attributes are the UNION of both parts, in part order with the
        // declaring part first — matching C#'s partial-method rule ("the
        // combined attributes of the defining and implementing declarations")
        // and ADR-0144 §C's annotation-union rule for type parts. This is the
        // load-bearing property for the motivating scenario: a generator-written
        // implementing part must not have to restate the `@GeneratedRegex(...)`
        // the user wrote on the declaring part, and the attribute must still
        // land on the one emitted method.
        var annotations = ImmutableArray.CreateBuilder<AnnotationSyntax>();
        if (!declaring.Annotations.IsDefaultOrEmpty)
        {
            annotations.AddRange(declaring.Annotations);
        }

        if (!implementing.Annotations.IsDefaultOrEmpty)
        {
            annotations.AddRange(implementing.Annotations);
        }

        merged.WithAnnotations(annotations.ToImmutable());
        return merged;
    }

    /// <summary>
    /// Renders a node as the concatenation of its leaf tokens' own kinds and
    /// exact text, ignoring only the layout BETWEEN tokens (whitespace,
    /// comments — never modeled as syntax children, so a recursive
    /// <see cref="SyntaxNode.GetChildren"/> walk never sees them).
    /// <para>
    /// Deliberately NOT <c>PartialTypeMerger</c>'s raw-text-minus-whitespace
    /// convention: stripping every whitespace character from the source slice
    /// also strips whitespace INSIDE a literal token's own text, so
    /// <c>x string = "a b"</c> and <c>x string = "ab"</c> compared equal — a
    /// real default-value mismatch silently accepted (Copilot review round
    /// 5). A partial method's parameters can carry a default-value literal;
    /// a partial type's base-clause/type-parameter list cannot, which is why
    /// that convention has stayed safe for <c>PartialTypeMerger</c>'s narrower
    /// use so far and is left alone here.
    /// </para>
    /// </summary>
    private static string NormalizeNodeText(SyntaxNode? node)
    {
        if (node == null)
        {
            return string.Empty;
        }

        var builder = new System.Text.StringBuilder();
        AppendTokenSignature(node, builder);
        return builder.ToString();
    }

    /// <summary>
    /// Recursively appends each leaf <see cref="SyntaxToken"/>'s kind and
    /// exact text to <paramref name="builder"/>, delimited so that no
    /// concatenation of two tokens' text can be mistaken for a different
    /// pair (e.g. <c>["a", "b"]</c> vs <c>["ab"]</c>).
    /// </summary>
    private static void AppendTokenSignature(SyntaxNode node, System.Text.StringBuilder builder)
    {
        if (node is SyntaxToken token)
        {
            // ADR-0170 / Copilot review round 8: an identifier token's
            // ValueText strips the `$` escape marker (`$T` and `T` are the
            // same identifier) -- everywhere else in the binder compares
            // identifiers this way. Scoped to IdentifierToken specifically
            // so every OTHER token kind (crucially, a string-literal
            // token's raw quoted text) keeps the exact Text comparison
            // round 5 relied on to preserve a literal's own content.
            var text = token.Kind == SyntaxKind.IdentifierToken ? token.ValueText : token.Text;
            builder.Append((int)token.Kind).Append('').Append(text).Append('');
            return;
        }

        foreach (var child in node.GetChildren())
        {
            AppendTokenSignature(child, builder);
        }
    }

    /// <summary>
    /// The identity of a partial method for grouping purposes: its name, its
    /// generic arity, and its parameter TYPES. Parameter types are part of the
    /// key because two partial methods of the same name may be distinct
    /// overloads — <c>partial func F(x int32);</c> and
    /// <c>partial func F(x string) { … }</c> are two unmatched declarations, not
    /// one mismatched pair, and keying on the name alone would pair them and
    /// then report a signature conflict the user never wrote.
    /// </summary>
    private readonly struct MethodKey : System.IEquatable<MethodKey>
    {
        private MethodKey(string name, int arity, string parameterTypes)
        {
            Name = name;
            Arity = arity;
            ParameterTypes = parameterTypes;
        }

        private string Name { get; }

        private int Arity { get; }

        private string ParameterTypes { get; }

        public static MethodKey For(FunctionDeclarationSyntax method)
        {
            // A generic method's own type parameters are positional, not
            // nominal, for the purpose of deciding WHICH method this is:
            // `Echo[T](value T)` and `Echo[U](value U)` are two parts of the
            // same method, and their differing spellings are a GS0611
            // consistency error — not two unrelated declarations. Substituting
            // `!0`, `!1`, … for the declaration's own type-parameter names
            // before hashing lets them group so that diagnostic can fire.
            // ValueText, because `$T` and `T` are the same name (ADR-0170).
            var typeParameterNames = method.TypeParameterList?.Parameters
                .Select(parameter => parameter.Identifier.ValueText ?? string.Empty)
                .Where(text => text.Length > 0)
                .ToList();

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
            var parameterTypes = string.Join(
                ",",
                method.Parameters.Select(parameter =>
                {
                    var refKind = parameter.RefKindModifier?.Text ?? string.Empty;
                    var variadic = parameter.IsVariadic ? "..." : string.Empty;
                    var type = TypeKey(parameter.Type, typeParameterNames);
                    return $"{refKind} {variadic}{type}";
                }));

            // ADR-0170: `$F` and `F` are equivalent spellings of the same
            // identifier — the binder consistently declares methods with
            // `Identifier.ValueText`, never the verbatim `Text` (which keeps
            // the `$`). Using `Text` here would split a declaring `partial
            // func $F();` and an implementing `partial func F() { … }` into
            // two unmatched, unrelated groups instead of pairing them
            // (Copilot review round 6).
            return new MethodKey(
                method.Identifier.ValueText ?? string.Empty,
                method.TypeParameterList?.Parameters.Count ?? 0,
                parameterTypes);
        }

        public bool Equals(MethodKey other)
            => string.Equals(Name, other.Name, System.StringComparison.Ordinal)
            && Arity == other.Arity
            && string.Equals(ParameterTypes, other.ParameterTypes, System.StringComparison.Ordinal);

        public override bool Equals(object? obj) => obj is MethodKey other && Equals(other);

        public override int GetHashCode() => System.HashCode.Combine(Name, Arity, ParameterTypes);

        /// <summary>
        /// Builds the grouping-key form of a parameter's type clause: each leaf
        /// token's kind and text, with identifier tokens compared by
        /// <c>ValueText</c> (ADR-0170) and every reference to one of the
        /// method's own type parameters replaced by its position (<c>!0</c>,
        /// <c>!1</c>, …).
        /// <para>
        /// Works on tokens, not source text: a raw-text scan rewrote any matching
        /// word, including the member segment of a qualified name, so
        /// <c>F[T](x Types.T)</c> and <c>F[U](x Types.U)</c> both keyed their
        /// parameter as <c>Types.!0</c> and two distinct overloads collapsed
        /// into one group (Copilot review round 11). A qualifier's member
        /// segments (<see cref="TypeClauseSyntax.QualifierIdentifierTokens"/>)
        /// name a member of the qualifier, never the method's own type
        /// parameter, so they are left as written.
        /// </para>
        /// </summary>
        private static string TypeKey(TypeClauseSyntax? type, List<string>? typeParameterNames)
        {
            if (type == null)
            {
                return string.Empty;
            }

            var builder = new System.Text.StringBuilder();
            var qualifierMembers = new HashSet<SyntaxToken>(ReferenceEqualityComparer.Instance);
            AppendTypeKey(type, typeParameterNames, qualifierMembers, builder);
            return builder.ToString();
        }

        private static void AppendTypeKey(
            SyntaxNode node,
            List<string>? typeParameterNames,
            HashSet<SyntaxToken> qualifierMembers,
            System.Text.StringBuilder builder)
        {
            if (node is TypeClauseSyntax { QualifierIdentifierTokens.IsDefaultOrEmpty: false } qualified)
            {
                qualifierMembers.UnionWith(qualified.QualifierIdentifierTokens);
            }

            if (node is SyntaxToken token)
            {
                var text = token.Text;
                if (token.Kind == SyntaxKind.IdentifierToken)
                {
                    text = token.ValueText;
                    var position = qualifierMembers.Contains(token) ? -1 : typeParameterNames?.IndexOf(text) ?? -1;
                    if (position >= 0)
                    {
                        text = "!" + position.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    }
                }

                builder.Append((int)token.Kind).Append('\x01').Append(text).Append('\x02');
                return;
            }

            foreach (var child in node.GetChildren())
            {
                AppendTypeKey(child, typeParameterNames, qualifierMembers, builder);
            }
        }
    }
}
