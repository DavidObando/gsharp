// <copyright file="ExpressionBinder.Literals.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import System.Globalization
import System.Runtime.CompilerServices
import System.Threading

internal partial class ExpressionBinder {
    private func BindMakeChannelExpression(syntax MakeChannelExpressionSyntax) BoundExpression {
        // ADR-0174 D12: the parser already reported GS0566 for the retired
        // `make(chan T[, n])`. Bind it as the construction it names so the
        // rest of the file keeps binding (no cascade). Note the SEMANTIC
        // difference the diagnostic spells out: `make(chan T)` was unbounded,
        // `chan[T]()` is a rendezvous channel.
        let typeSymbol = bindTypeClause(syntax.ChannelTypeClause)
        if typeSymbol is not ChannelTypeSymbol chan_ {
            return BoundErrorExpression(nil)
        }
        var capacity BoundExpression? = nil
        if syntax.Capacity != nil {
            capacity = conversions.BindConversion(syntax.Capacity, TypeSymbol.Int32)
        }
        return BindChannelConstruction(syntax, syntax.Location, chan_, capacity)
    }

    private func BindChannelCreationExpression(syntax ChannelCreationExpressionSyntax) BoundExpression {
        // ADR-0174 D12: `chan[T]()` is a rendezvous channel, `chan[T](n)` a
        // buffered one. The type clause applied to arguments — the same shape
        // as `List[int32]()` and the exact parallel of `map[K,V]{…}`.
        let typeSymbol = bindTypeClause(syntax.TypeClause)
        if typeSymbol is not ChannelTypeSymbol chan_ {
            return BoundErrorExpression(syntax)
        }
        if syntax.Arguments.Count > 1 {
            Diagnostics.ReportWrongArgumentCount(
                syntax.OpenParenthesis.Location,
                chan_.Name,
                expectedCount: 1,
                actualCount: syntax.Arguments.Count
            )
            return BoundErrorExpression(syntax)
        }
        var capacity BoundExpression? = nil
        if syntax.Arguments.Count == 1 {
            capacity = conversions.BindConversion(syntax.Arguments[0], TypeSymbol.Int32)
        } else {
            // GS0548: advisory for the reader who wanted a buffer and did not
            // supply one. Migrated `make(chan T)` sites are rewritten by
            // GS0566, not warned about here.
            Diagnostics.ReportRendezvousChannelConstructed(syntax.Location, chan_.ElementType.Name)
        }
        return BindChannelConstruction(syntax, syntax.Location, chan_, capacity)
    }

    private func BindChannelConstruction(
        syntax SyntaxNode,
        location TextLocation,
        $chan ChannelTypeSymbol,
        capacity BoundExpression?
    ) BoundExpression {
        if $chan.Direction != ChannelDirection.Both {
            // Only a bidirectional channel can be constructed; directional
            // handles are views obtained by conversion.
            Diagnostics.ReportWrongArgumentCount(location, $chan.Name, expectedCount: 0, actualCount: 0)
            return BoundErrorExpression(syntax)
        }
        if !EnsureChannelRuntime(location) {
            return BoundErrorExpression(syntax)
        }
        return binderCtx.ChannelRuntime.BindConstruction(syntax, $chan.ElementType, capacity)
    }

    internal func BindTypeOfExpression(syntax TypeOfExpressionSyntax) BoundExpression {
        // Issue #143: `typeof(T)` returns System.Type for the referenced type.
        //
        // Issue #1915: G# has no bracket syntax for an UNBOUND generic (there is
        // no `List[]`/`List<>` spelling), so a bare generic name with no
        // type-argument list, qualifier, array shape, or nullable suffix is read
        // as the OPEN generic type definition specifically in this `typeof(...)`
        // position — the only place an open generic is ever a meaningful,
        // usable value (elsewhere, e.g. a variable's declared type or a
        // static-member receiver, an unbound generic has no accessible members
        // and a bare name legitimately stays a GS0113). Attempted BEFORE the
        // ordinary type-clause bind so a hit here never also trips the
        // `ReportUndefinedType` diagnostic that path raises on failure.
        // Issue #1989: a bare name only ever disambiguates a UNIQUE arity
        // (`List` → `List`1`). Same-base-name BCL families across several
        // arities (`Func`, `Action`, `Tuple`, `ValueTuple`, …) need an
        // explicit arity. G# has no `Name<>`/`Name<,>` spelling, so the
        // arity is carried the same way C# derives it — by comma count — but
        // over G#'s own bracket generics via `_` placeholder arguments:
        // `typeof(Func[_])` is arity 1, `typeof(Func[_, _])` is arity 2, etc.
        // This form always resolves the arity-suffixed generic and never
        // falls back to a same-named non-generic type (`typeof(Action[_])`
        // can never silently become non-generic `Action`).
        let typeClause = syntax.TypeClause
        var typeSymbol TypeSymbol? = nil
        if typeClause.ReadOnlySpanModifier != nil &&
            (
            typeClause.HasQualifier || typeClause.Identifier == nil || !binderCtx.CanUseSpanAlias(
                $scope,
                typeClause.Identifier,
                getCurrentFunction()
            )
        ) {
            bindTypeClause(typeClause)
            return BoundErrorExpression(nil)
        }
        var spanArity = 1
        if !typeClause.HasQualifier &&
            !typeClause.IsArray &&
            !typeClause.IsNullable &&
            typeClause.Identifier is {} spanName &&
            binderCtx.CanUseSpanAlias($scope, spanName, getCurrentFunction()) &&
            (!typeClause.HasTypeArguments || TryGetUnboundGenericArity(typeClause, out spanArity)) {
            if spanArity != 1 {
                Diagnostics.ReportNativeSpanType(
                    typeClause.Location,
                    "span[T] and readonly span[T] require exactly one element type"
                )
                return BoundErrorExpression(nil)
            }
            if !ClrSpanTypes.TryResolveDefinition(
                $scope.References!!,
                typeClause.ReadOnlySpanModifier != nil,
                out var definition
            ) {
                Diagnostics.ReportNativeSpanType(
                    typeClause.Location,
                    "the target core library must provide CLR Span[T] and ReadOnlySpan[T]"
                )
                return BoundErrorExpression(nil)
            }
            typeSymbol = TypeSymbol.FromClrTypeWithoutNullability(definition, NullabilityFreeReason.ResolvedTypeName)
        }
        if typeSymbol == nil &&
            typeClause.Identifier is {} typeClauseIdentifier &&
            !typeClause.IsArray &&
            !typeClause
            .IsNullable {
            if !typeClause.HasQualifier && !typeClause.HasTypeArguments {
                TryResolveOpenGenericImportedType(typeClauseIdentifier.ValueText, out typeSymbol)
            } else if TryGetNestedUnboundGenericReflectionSegments(
                typeClause,
                out var reflectionSegments,
                out var firstGenericSegment,
                out var segmentNames,
                out var segmentArities
            ) {
                let qualifiedType Type? = ResolveNestedUnboundGenericType(
                    reflectionSegments,
                    firstGenericSegment,
                    out var reflectionName,
                    out var isAmbiguous
                )
                if qualifiedType != nil {
                    typeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
                        qualifiedType,
                        NullabilityFreeReason.ResolvedTypeName
                    )
                } else if isAmbiguous {
                    Diagnostics.ReportAmbiguousImportedType(typeClause.Location, reflectionName)
                    return BoundErrorExpression(nil)
                } else if !TryResolveOpenGenericDeclaredNestedType(segmentNames, segmentArities, out typeSymbol) {
                    // Issue #3677: the reflection walk above only ever consults
                    // REFERENCED assemblies, so the nested unbound spelling
                    // (`typeof(Outer[_].Inner[_])`) could not name a type
                    // declared in THIS compilation. The declaration table is
                    // consulted last, so an imported match still wins exactly
                    // as before.
                    Diagnostics.ReportUndefinedType(typeClause.Location, reflectionName)
                    return BoundErrorExpression(nil)
                }
            } else if typeClause.HasTypeArguments && TryGetUnboundGenericArity(typeClause, out var arity) {
                var resolved bool
                var isAmbiguous bool
                if typeClause.HasQualifier {
                    resolved = $scope.References!!.TryResolveType(
                        typeClause.DottedName + "`" + arity.ToString(),
                        out var qualifiedType
                    )
                    typeSymbol = if resolved {
                        TypeSymbol.FromClrTypeWithoutNullability(qualifiedType, NullabilityFreeReason.ResolvedTypeName)
                    } else {
                        default(TypeSymbol?)
                    }
                    isAmbiguous = false
                } else {
                    resolved = TryResolveOpenGenericImportedTypeWithArity(
                        typeClauseIdentifier.ValueText,
                        arity,
                        out typeSymbol,
                        out isAmbiguous
                    )
                }
                // Issue #3678: both walks above only ever consult REFERENCED
                // assemblies, so the explicit-arity spelling could not name a
                // generic type declared in THIS compilation —
                // `typeof(Slot[_])` on a source `class Slot[T]` failed with
                // GS0113 even though the bare `typeof(Slot)` form resolves it
                // through `bindTypeClause`. Try the declaration table last, so
                // an imported match still wins exactly as before.
                // Issue #3677: the QUALIFIED spelling (`typeof(A.B[_, _])`)
                // needs the same fallback, walking the source enclosing-type /
                // package chain segment by segment rather than by reflection
                // name.
                if !resolved && !isAmbiguous {
                    resolved = if typeClause.HasQualifier {
                        TryResolveOpenGenericDeclaredQualifiedType(typeClause, arity, out typeSymbol)
                    } else {
                        TryResolveOpenGenericDeclaredType(typeClauseIdentifier.ValueText, arity, out typeSymbol)
                    }
                }
                if !resolved {
                    // Issue #2012 (N3): "ambiguous across imports" and "no
                    // match at all" are different failure modes and deserve
                    // different diagnostics — ambiguous means too MANY
                    // candidates matched, not that the type is undefined.
                    if isAmbiguous {
                        Diagnostics.ReportAmbiguousImportedType(
                            typeClause.Location,
                            typeClauseIdentifier.ValueText + "`" + arity.ToString()
                        )
                    } else {
                        Diagnostics.ReportUndefinedType(
                            typeClause.Location,
                            typeClause.DottedName + "`" + arity.ToString()
                        )
                    }
                    return BoundErrorExpression(nil)
                }
            }
        }
        typeSymbol ??= bindTypeClause(syntax.TypeClause)
        if typeSymbol == nil || typeSymbol == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        let systemType = ImportedTypeSymbol.GetWithoutNullability(typeof(Type), NullabilityFreeReason.TypeLiteral)
        return BoundTypeOfExpression(nil, typeSymbol, systemType)
    }

    /// Issue #1915: resolves a bare simple name to an imported CLR generic
    /// type's OPEN (unbound) definition — e.g. `List` with `import
    /// System.Collections.Generic` resolves to `List<>` — by
    /// trying each in-scope import's target namespace with an arity-suffixed
    /// (``1`, ``2`, …) reflection name. Returns `false`
    /// when the plain (non-generic) name already resolves to something else
    /// (the ordinary path must always win), or when no unique generic match is
    /// found across every import and arity (an ambiguous or absent match falls
    /// back to the ordinary "type doesn't exist" diagnostic rather than
    /// guessing).
    private func TryResolveOpenGenericImportedType(name string, out type TypeSymbol?) bool {
        type = nil
        if string.IsNullOrEmpty(name) || lookupType(name) != nil {
            return false
        }
        // Issue #1989: no fixed arity cap — a metadata arity limit doesn't
        // really exist, so we walk arities upward and stop once a small
        // streak of consecutive misses (BCL generic families are always
        // contiguous, e.g. Func`1..Func`16) confirms there's nothing higher.
        //
        // Issue #2012 (N2): this walk assumes CONTIGUOUS arity families —
        // a family with real members only at, say, arity 1 and arity 4,
        // with gaps at 2 and 3, would stop after the 2-miss streak and never
        // reach arity 4. No BCL family is shaped like this today (every
        // multi-arity BCL generic — Func, Action, Tuple, ValueTuple, etc. —
        // fills every arity in its range), so this is a documented
        // limitation rather than a bug fix: a gapped family simply falls
        // back to the ordinary "type doesn't exist" diagnostic (GS0113),
        // never a silent wrong resolution. If a real gapped family ever
        // needs support, bump <see cref="MaxConsecutiveArityMisses"/>.
        var match Type? = nil
        var missStreak = 0
        for var arity = 1; missStreak < MaxConsecutiveArityMisses; arity++ {
            var foundAtThisArity = false
            for import_ in $scope.GetDeclaredImports() {
                let candidateName = import_.Target + "." + name + "`" + arity.ToString()
                if $scope.References!!.TryResolveType(candidateName, out var candidate) {
                    foundAtThisArity = true
                    if match != nil && match != candidate {
                        // Ambiguous across imports/arities — defer to the
                        // ordinary diagnostic rather than guessing.
                        return false
                    }
                    match = candidate
                }
            }
            missStreak = if foundAtThisArity {
                0
            } else {
                missStreak + 1
            }
        }
        if match == nil {
            return false
        }
        type = TypeSymbol.FromClrTypeWithoutNullability(match, NullabilityFreeReason.ResolvedTypeName)
        return true
    }

    /// Issue #3678: resolves an explicit-arity unbound generic
    /// (`Slot[_]`, `Pair[_, _]`) to a generic type DECLARED IN THIS
    /// COMPILATION, at the EXACT requested arity. The imported walks
    /// ((cref:TryResolveOpenGenericImportedType) /
    /// (cref:TryResolveOpenGenericImportedTypeWithArity)) only search
    /// referenced assemblies, so without this a source generic was reachable
    /// through the bare `typeof(Slot)` spelling but not through the
    /// arity-bearing one — the only spelling available when the base name is
    /// shared by several arities.
    /// @param name The bare generic base name.
    /// @param arity The exact requested arity.
    /// @param type The resolved open generic definition on success.
    /// @returns `true` when a declared generic definition of that arity was found.
    private func TryResolveOpenGenericDeclaredType(name string, arity int32, out type TypeSymbol?) bool {
        type = nil
        let candidate TypeSymbol? = lookupType(name)
        if candidate == nil || DeclaredGenericDefinitionArity(candidate) != arity {
            return false
        }
        type = candidate
        return true
    }

    /// Issue #3677: resolves the QUALIFIED explicit-arity unbound-generic
    /// spelling (`typeof(Fixtures.IQuery[_])`,
    /// `typeof(Demo.Fixtures.IChain[_, _])`) against types DECLARED IN
    /// THIS COMPILATION. The qualified branch of
    /// (cref:BindTypeOfExpression) resolves through
    /// `scope.References.TryResolveType(DottedName + "`" + arity)`, a
    /// reflection-name lookup that only ever sees referenced assemblies, so a
    /// source-declared nested generic was unreachable through the only
    /// spelling that can select an arity.
    /// @param typeClause The `typeof(...)` target type clause.
    /// @param arity The requested arity, carried by the deepest segment's `_` placeholders.
    /// @param type The resolved open generic definition on success.
    /// @returns `true` when the dotted name resolved to a declared generic definition of that arity.
    private func TryResolveOpenGenericDeclaredQualifiedType(
        typeClause TypeClauseSyntax,
        arity int32,
        out type TypeSymbol?
    ) bool {
        type = nil
        let names = typeClause.DottedName.Split('.')
        if names.Length < 2 {
            return false
        }
        let arities = [names.Length]int32
        Array.Fill(arities, -1)
        arities[names.Length - 1] = arity
        return TryResolveOpenGenericDeclaredNestedType(names, arities, out type)
    }

    /// Issue #3677: resolves a dotted open-generic `typeof(...)` target
    /// against the declaration table by walking SOURCE symbols — the head
    /// segment through the ordinary source-type lookup (so lexical nesting,
    /// packages and imports apply), every later segment as a nested type of the
    /// previously-resolved container. Leading segments that do not name a type
    /// are skipped — that is how a package qualifier
    /// (`Fixtures2523.IQuery2523[_]`) resolves — but only when they spell
    /// the head's declaring package (see
    /// (cref:PrefixMatchesDeclaringPackage)); the longest chain (the
    /// earliest viable head) wins, matching
    /// (cref:Binder.TryResolveUserNestedTypeChain).
    /// Every segment's declared shape is verified against
    /// [`arities`](paramref), so a wrong-arity spelling keeps reporting
    /// GS0113 rather than silently binding a same-named homonym.
    /// @param names The raw per-segment names, outermost first.
    /// @param arities The per-segment requested arity, or -1 for a segment with no `_` placeholders.
    /// @param type The resolved type on success.
    /// @returns `true` when the whole chain resolved to declared types of the requested shapes.
    private func TryResolveOpenGenericDeclaredNestedType(names[]string, arities[]int32, out type TypeSymbol?) bool {
        type = nil
        for var head = 0; head < names.Length; head++ {
            if !binderCtx.TryLookupSourceType(
                $scope,
                names[head],
                arities[head],
                getCurrentFunction(),
                out var current,
                out _
            ) ||
                !DeclaredSegmentShapeMatches(current!!, arities[head]) ||
                !PrefixMatchesDeclaringPackage(current!!, names, head) {
                continue
            }
            var resolved = true
            for var i = head + 1; i < names.Length; i++ {
                let container = (current as StructSymbol)?.Definition ?? current
                if !$scope.TryLookupNestedTypeAlias(container, names[i], arities[i], out var nested) &&
                    !(
                    container is StructSymbol containerStruct && $scope.TryLookupNestedTypeAliasIncludingInherited(
                        containerStruct,
                        names[i],
                        arities[i],
                        out nested,
                        out _
                    )
                ) {
                    resolved = false
                    break
                }
                if !DeclaredSegmentShapeMatches(nested!!, arities[i]) {
                    resolved = false
                    break
                }
                current = nested
            }
            if resolved {
                type = current
                return true
            }
        }
        return false
    }

    private func TryGetNestedUnboundGenericReflectionSegments(
        typeClause TypeClauseSyntax,
        out segments[]string,
        out firstGenericSegment int32,
        out names[]string,
        out arities[]int32
    ) bool {
        segments = Array.Empty[string]()
        names = Array.Empty[string]()
        arities = Array.Empty[int32]()
        firstGenericSegment = -1
        if !typeClause.HasQualifier || typeClause.IsArray || typeClause.IsNullable || lookupType("_") != nil {
            return false
        }
        segments = [typeClause.SegmentCount]string
        segments[0] = Invariant.Required(
            typeClause.Identifier,
            "a named type clause has an identifier",
            expression: "typeClause.Identifier"
        )
            .Text
        for var i = 1; i < segments.Length; i++ {
            segments[i] = typeClause.QualifierIdentifierTokens[i - 1].Text
        }
        // Issue #3677: the source-declaration fallback walks SYMBOLS, not
        // `+`-joined reflection names, so it needs the raw per-segment name and
        // arity next to the arity-mangled reflection segments built below.
        names = cast[[]string](segments.Clone())
        arities = [segments.Length]int32
        Array.Fill(arities, -1)
        for var i = 0; i < segments.Length; i++ {
            let args GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[TypeClauseSyntax]? = typeClause.GetSegmentTypeArguments(i)
            if args == nil {
                continue
            }
            if args.Count == 0 || args.Any(
                (arg TypeClauseSyntax) -> arg
                    .Identifier
                    ?.Text != "_" ||
                    arg.HasQualifier ||
                    arg.HasTypeArguments ||
                    arg.IsArray ||
                    arg.IsNullable
            ) {
                return false
            }
            firstGenericSegment = if firstGenericSegment < 0 {
                i
            } else {
                firstGenericSegment
            }
            arities[i] = args.Count
            segments[i] += "`" + args.Count.ToString()
        }
        if firstGenericSegment < 0 || firstGenericSegment == segments.Length - 1 {
            return false
        }
        return true
    }

    private func ResolveNestedUnboundGenericType(
        segments[]string,
        firstGenericSegment int32,
        out reflectionName string,
        out isAmbiguous bool
    ) Type? {
        reflectionName = string.Empty
        isAmbiguous = false
        for var firstTypeSegment = firstGenericSegment; firstTypeSegment >= 0; firstTypeSegment-- {
            let builder = StringBuilder(segments[0])
            for var i = 1; i < segments.Length; i++ {
                builder.Append(
                    if i > firstTypeSegment {
                        '+'
                    } else {
                        '.'
                    }
                )
                    .Append(segments[i])
            }
            reflectionName = builder.ToString()
            if $scope.References!!.TryResolveType(reflectionName, out var direct) && direct != nil {
                return direct
            }
            let imported Type? = ResolveImportedReflectionType(reflectionName, out isAmbiguous)
            if imported != nil {
                return imported
            }
            if isAmbiguous {
                return nil
            }
        }
        return nil
    }

    private func ResolveImportedReflectionType(reflectionName string, out isAmbiguous bool) Type? {
        isAmbiguous = false
        var match Type? = nil
        for import_ in $scope.GetDeclaredImports() {
            if !$scope.References!!.TryResolveType(import_.Target + "." + reflectionName, out var candidate) {
                continue
            }
            if match != nil && match != candidate {
                isAmbiguous = true
                return nil
            }
            match = candidate
        }
        return match
    }

    /// Issue #1989: an unbound-generic `typeof(...)` target with an
    /// EXPLICIT requested arity, spelled with `_` placeholder type
    /// arguments (G#'s analogue of C#'s comma-count `Name<>` /
    /// `Name<,>` unbound-generic syntax, since G# generics use
    /// `Name[T1, T2]` brackets rather than angle brackets). Returns
    /// `true` with [`arity`](paramref) set to the
    /// argument count only when every type argument is a bare `_` (no
    /// qualifier, nested type arguments, array shape, or nullable suffix) —
    /// any real type argument is an ordinary bound generic and is left to
    /// (cref:bindTypeClause).
    ///
    /// Issue #2012 (N1): `_` is an ordinary identifier in G#'s grammar
    /// (it is only special-cased in pattern/discard positions, never
    /// reserved as a type-name token), so user code CAN legally declare a
    /// real type literally named `_` (`class _ {}`, `type _ =
    /// ...`, or a type parameter named `_`). If such a type is in
    /// scope, treating every `_` type argument as the unbound-generic
    /// placeholder would silently ignore it and flip `Func[_]` from
    /// "bound to the real type `_`" to "unbound `Func`1`" — a
    /// genuine (if contrived) silent semantic change. So a real type named
    /// `_` in scope always wins: this method only claims the
    /// placeholder reading when no such type is resolvable, deferring to
    /// (cref:bindTypeClause) otherwise.
    private func TryGetUnboundGenericArity(typeClause TypeClauseSyntax, out arity int32) bool {
        arity = 0
        let args = Invariant.Required(
            typeClause.TypeArguments,
            "an unbound generic has type arguments",
            expression: "typeClause.TypeArguments"
        )
        if args.Count == 0 {
            return false
        }
        if lookupType("_") != nil {
            // A real type named `_` is in scope (respecting normal
            // shadowing/scoping rules via `lookupType`) — every `_` type
            // argument binds to it as an ordinary type, never the
            // open-generic placeholder.
            return false
        }
        for arg in args {
            if arg
                .Identifier
                ?.Text != "_" ||
                arg.HasQualifier ||
                arg.HasTypeArguments ||
                arg.IsArray ||
                arg.IsNullable {
                return false
            }
        }
        arity = args.Count
        return true
    }

    /// Issue #1989: resolves [`name`](paramref) to an imported CLR
    /// generic type's OPEN definition at the EXACT requested
    /// [`arity`](paramref) (e.g. `Func` + arity 2 → `Func`2`).
    /// Unlike (cref:TryResolveOpenGenericImportedType), this never
    /// considers the plain non-generic name a match — the caller already
    /// determined the target is an explicit unbound generic — so it can
    /// never silently return the wrong (non-generic) type for names like
    /// `Action` that have both a non-generic and generic overload set.
    /// @param name The bare generic base name (e.g. `Func`).
    /// @param arity The exact requested arity.
    /// @param type The resolved open-generic type on success.
    /// @param isAmbiguous Issue #2012 (N3): set to `true` when two or more
    /// imports contribute DIFFERENT candidates at this arity — distinct from
    /// the "no match at all" case — so the caller can raise the correct
    /// ambiguity diagnostic instead of the misleading "type doesn't exist".
    private func TryResolveOpenGenericImportedTypeWithArity(
        name string,
        arity int32,
        out type TypeSymbol?,
        out isAmbiguous bool
    ) bool {
        type = nil
        isAmbiguous = false
        if string.IsNullOrEmpty(name) || arity <= 0 {
            return false
        }
        var match Type? = nil
        for import_ in $scope.GetDeclaredImports() {
            let candidateName = import_.Target + "." + name + "`" + arity.ToString()
            if $scope.References!!.TryResolveType(candidateName, out var candidate) {
                if match != nil && match != candidate {
                    // Ambiguous across imports — let the caller raise the
                    // ambiguity diagnostic rather than "type doesn't exist".
                    isAmbiguous = true
                    return false
                }
                match = candidate
            }
        }
        if match == nil {
            return false
        }
        type = TypeSymbol.FromClrTypeWithoutNullability(match, NullabilityFreeReason.ResolvedTypeName)
        return true
    }

    internal func BindSizeOfExpression(syntax SizeOfExpressionSyntax) BoundExpression {
        // Issue #1336: `sizeof(T)` returns the unmanaged byte size of T as an
        // int32, emitted via the CIL `sizeof <T>` opcode (which accepts a
        // generic type token). The operand must be an unmanaged type — a
        // blittable primitive, an enum, a pointer, a blittable value struct, or
        // a generic type parameter constrained `unmanaged`. This mirrors C#'s
        // `sizeof` over unmanaged types and shares the emit path the
        // unmanaged-pointer arithmetic lowering already uses (ADR-0122 §4).
        let typeSymbol TypeSymbol? = bindTypeClause(syntax.TypeClause)
        if typeSymbol == nil || typeSymbol == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        if !Binder.IsUnmanagedTypeForConstraint(typeSymbol) {
            Diagnostics.ReportSizeOfRequiresUnmanagedType(syntax.TypeClause.Location, typeSymbol.Name)
            return BoundErrorExpression(nil)
        }
        return BoundSizeOfExpression(nil, typeSymbol)
    }

    internal func BindDefaultExpression(syntax DefaultExpressionSyntax) BoundExpression {
        // ADR-0100 / issue #795: `default(T)` and bare `default`.
        //
        // The explicit form (`default(T)`) carries its type directly.
        //
        // The bare form has no type clause; its concrete type is supplied
        // by the surrounding target-typed position. To compose with the
        // existing bind-then-convert pipeline (StatementBinder for
        // let/var/return, OverloadResolver for call arguments,
        // ExpressionBinder.BindConditionalExpression for `?:`), we emit
        // a placeholder `BoundDefaultExpression(syntax, TypeSymbol.Error)`
        // here and let `ConversionClassifier.BindConversion` materialise
        // the concrete-typed default at the use site. The dedicated
        // `BindConversion(ExpressionSyntax, TypeSymbol)` overload already
        // intercepts the bare-default syntax before this dispatcher
        // fires, so the placeholder is only observed when the bare form
        // surfaces via the eager `BindExpression(syntax)` path used by
        // argument binding and overload resolution. If the placeholder
        // ever leaks to a position without a target type (e.g.
        // `var x = default`), the conversion step reports GS0362.
        if syntax.TypeClause == nil {
            return BoundDefaultExpression(syntax, TypeSymbol.Error)
        }
        let typeSymbol TypeSymbol? = bindTypeClause(syntax.TypeClause!!)
        if typeSymbol == nil || typeSymbol == TypeSymbol.Error {
            return BoundErrorExpression(syntax)
        }
        return BoundDefaultExpression(syntax, typeSymbol)
    }

    private func BindNameOfExpression(syntax NameOfExpressionSyntax) BoundExpression {
        // Issue #143: `nameof(expr)` is folded to a compile-time string of
        // the unqualified short name. The argument must be a name reference
        // (identifier, member access, or type). `nameof(this)` / `nameof(it)`
        // are rejected to match C# semantics.
        if TryExtractNameOfName(syntax.Argument, out var name) {
            return BoundLiteralExpression(nil, name)
        }
        Diagnostics.ReportNameOfRequiresNameReference(syntax.Argument.Location)
        return BoundErrorExpression(nil)
    }

    private func BindLiteralExpression(syntax LiteralExpressionSyntax) BoundExpression {
        if syntax.LiteralToken.Kind == SyntaxKind.Utf8StringToken {
            if !ClrSpanTypes.TryResolveUtf8Literal(
                $scope.References!!,
                out var spanType,
                out var createSpan,
                out var slice
            ) {
                Diagnostics.ReportInvalidUtf8StringLiteral(
                    syntax.Location,
                    "UTF-8 literals require canonical ReadOnlySpan<byte>, RuntimeHelpers.CreateSpan<byte>, and Slice(int32,int32)"
                )
                return BoundErrorExpression(syntax)
            }
            return BoundUtf8StringExpression(
                syntax,
                cast[ImmutableArray[uint8]](syntax.Value!!),
                TypeSymbol.FromClrTypeWithoutNullability(spanType, NullabilityFreeReason.ResolvedTypeName),
                createSpan,
                slice
            )
        }
        if syntax.LiteralToken.Kind == SyntaxKind.ByteStringToken {
            if !ByteStringTypes.TryResolveDefinition($scope.References!!, out var byteStringType) {
                Diagnostics.ReportByteStringRuntime(syntax.Location)
                return BoundErrorExpression(syntax)
            }
            let bytes = cast[ImmutableArray[uint8]](syntax.Value!!)
            let factory = Invariant.Required(
                ByteStringTypes.GetLiteralFactory(byteStringType),
                "validated byte-string runtime provides the literal factory",
                expression: "ByteStringTypes.GetLiteralFactory(byteStringType)"
            )
            return BoundClrStaticCallExpression(
                syntax,
                factory,
                TypeSymbol.FromClrTypeWithoutNullability(byteStringType, NullabilityFreeReason.ResolvedTypeName),
                ImmutableArray.Create[BoundExpression](
                    BoundLiteralExpression(syntax, Convert.ToHexString(bytes.AsSpan()))
                )
            )
        }
        // Phase 3.C.2: a literal whose syntax value is null is the `nil`
        // literal — preserve null so BoundLiteralExpression picks the Null
        // sentinel type. All other literals default missing values to 0
        // for legacy parser robustness.
        var value object? = syntax.Value
        if value == nil && syntax.LiteralToken.Kind != SyntaxKind.NilKeyword {
            value = 0
        }
        return BoundLiteralExpression(nil, value)
    }

    private func BindInterpolatedStringExpression(syntax InterpolatedStringExpressionSyntax) BoundExpression {
        // ADR-0055 (Phase 2): bind `"a $x b ${expr,align:fmt} c"` to a dedicated
        // BoundInterpolatedStringExpression carrying the ordered literal/hole
        // parts. Lowering is deferred (late) so that format/alignment intent is
        // preserved through binding — the interpreter renders the node directly,
        // and the emitter lowers it to the DefaultInterpolatedStringHandler
        // pattern (issue #368). This replaces the legacy eager `+`-chain that
        // mis-asserted `string`/`string?` operand types and produced the #366
        // memory-unsafe IL.
        let parts = ImmutableArray.CreateBuilder[BoundInterpolatedStringPart](syntax.Segments.Length)
        for segment in syntax.Segments {
            if segment.IsExpression {
                let segmentExpression = Invariant.Required(
                    segment.Expression,
                    "an interpolation segment has an expression",
                    expression: "segment.Expression"
                )
                var bound = BindExpression(segmentExpression)
                bound = BindNaturalMethodGroupValue(bound, segmentExpression.Location)
                if bound is BoundErrorExpression {
                    return bound
                }
                if bound.Type == nil || bound.Type == TypeSymbol.Void {
                    Diagnostics.ReportCannotConvert(
                        segmentExpression.Location,
                        bound.Type ?? TypeSymbol.Error,
                        TypeSymbol.String
                    )
                    return BoundErrorExpression(nil)
                }
                if bound.Type is StructSymbol{IsRefStruct: true} structType && structType.TryGetMethod(
                    "ToString",
                    out _
                ) {
                    let diagMark = Diagnostics.Count
                    let toString = BindAccessorCall(
                        bound,
                        classSymbol: nil,
                        SynthesizeInstanceCall(segmentExpression, "ToString", ImmutableArray[ExpressionSyntax].Empty)
                    )
                    if toString is BoundUserInstanceCallExpression{Type: var returnType} &&
                        returnType == TypeSymbol.String {
                        bound = toString
                    } else {
                        Diagnostics.TruncateTo(diagMark)
                    }
                }
                parts.Add(
                    BoundInterpolatedStringPart.FromHole(bound, segment.Alignment, segment.Format, segment.Expression)
                )
            } else {
                parts.Add(BoundInterpolatedStringPart.FromLiteral(segment.Text ?? string.Empty))
            }
        }
        return BoundInterpolatedStringExpression(syntax, parts.ToImmutable())
    }

    private func BindNaturalMethodGroupValue(expression BoundExpression, location TextLocation) BoundExpression {
        if expression is BoundClrMethodGroupExpression{ResolvedMethod: nil} clrGroup {
            if TryGetNaturalClrMethodGroupType(clrGroup, out var naturalType) {
                return conversions.BindConversion(
                    location,
                    clrGroup,
                    Invariant.Required(
                        naturalType,
                        "a natural CLR method group has a function type",
                        expression: "naturalType"
                    )
                )
            }
            return MethodGroupDiagnostics.ReportRequiresTarget(Diagnostics, clrGroup, location)
        }
        if expression is BoundMethodGroupExpression userGroup {
            var naturalType FunctionTypeSymbol? = userGroup.FunctionType
            if naturalType != nil || TryGetNaturalUserMethodGroupType(userGroup, out naturalType) {
                return conversions.BindConversion(
                    location,
                    userGroup,
                    Invariant.Required(
                        naturalType,
                        "a natural user method group has a function type",
                        expression: "naturalType"
                    )
                )
            }
            return MethodGroupDiagnostics.ReportRequiresTarget(Diagnostics, userGroup, location)
        }
        return expression
    }

    private func TryGetNaturalClrMethodGroupType(
        group BoundClrMethodGroupExpression,
        @NotNullWhen(true) out naturalType FunctionTypeSymbol?
    ) bool {
        naturalType = nil
        var closesReceiver = group.Receiver != nil
        for candidate in group.Candidates {
            closesReceiver &= candidate.IsStatic
        }
        let receiverClr Type? = if closesReceiver {
            NullableTypeSymbol.GetEffectiveClrType(
                Invariant.Required(group.Receiver, "a closed method group has a receiver", expression: "group.Receiver")
                    .Type
            )
        } else {
            default(Type?)
        }
        var bestMethod MethodInfo? = nil
        var bestReceiverConversion = ClrOverloadResolution.ImplicitConversionKind.None
        var bestIsTied = false
        for candidate in group.Candidates {
            if candidate.ContainsGenericParameters || candidate.ReturnType.IsByRef {
                continue
            }
            let parameters = ImportedFunctionSymbol.GetLogicalParameters(candidate)
            var hasByRefParameter = false
            for parameter in parameters {
                hasByRefParameter |= parameter.ParameterType.IsByRef
            }
            if hasByRefParameter || (closesReceiver && (parameters.Length == 0 || receiverClr == nil)) {
                continue
            }
            let receiverConversion = if closesReceiver {
                ClrOverloadResolution.ClassifyImplicit(parameters[0].ParameterType, receiverClr)
            } else {
                ClrOverloadResolution.ImplicitConversionKind.Identity
            }
            if receiverConversion == ClrOverloadResolution.ImplicitConversionKind.None {
                continue
            }
            if bestMethod == nil || int32(receiverConversion) < int32(bestReceiverConversion) {
                bestMethod = candidate
                bestReceiverConversion = receiverConversion
                bestIsTied = false
            } else if receiverConversion == bestReceiverConversion {
                bestIsTied = true
            }
        }
        if bestMethod == nil || bestIsTied {
            return false
        }
        let method = bestMethod
        let methodParameters = ImportedFunctionSymbol.GetLogicalParameters(method)
        let offset = if closesReceiver {
            1
        } else {
            0
        }
        let parameterTypes = [methodParameters.Length - offset]TypeSymbol
        for var i = offset; i < methodParameters.Length; i++ {
            parameterTypes[i - offset] = ClrNullability.GetParameterTypeSymbol(methodParameters[i])
        }
        let returnType = if method.ReturnType.IsSameAs(typeof(Void)) {
            TypeSymbol.Void
        } else {
            ClrNullability.GetReturnTypeSymbol(method)
        }
        naturalType = FunctionTypeSymbol.Get(ImmutableArray.CreateRange[TypeSymbol](parameterTypes), returnType)
        return naturalType!!.ClrType != nil
    }

    private func TryGetNaturalUserMethodGroupType(
        group BoundMethodGroupExpression,
        @NotNullWhen(true) out naturalType FunctionTypeSymbol?
    ) bool -> TryGetSymbolicUserMethodGroupType(group, out naturalType) &&
        naturalType!!.ClrType != nil

    /// Issue #3712: recovers the symbolic (pre-erasure) function type of a
    /// user-declared method group. When [`expectedParameterCount`](paramref)
    /// is supplied the group's candidates are first narrowed to the single
    /// candidate of that arity, so an OVERLOADED group still yields a symbolic
    /// type once the target delegate's shape is known. Without the filter an
    /// overloaded group has no natural type and the symbolic argument vector
    /// falls back to the erased CLR shape, which silently instantiates a
    /// generic call over `object`.
    /// @param group The bound method group.
    /// @param naturalType The recovered symbolic function type, on success.
    /// @param expectedParameterCount Optional target-delegate arity used to disambiguate an overloaded
    /// group.
    /// @returns `true` when a single symbolic candidate was recovered.
    private func TryGetSymbolicUserMethodGroupType(
        group BoundMethodGroupExpression,
        @NotNullWhen(true) out naturalType FunctionTypeSymbol?,
        expectedParameterCount int32? = nil
    ) bool {
        naturalType = nil
        if !TryGetUniqueSymbolicMethodGroupCandidate(group, expectedParameterCount, out var candidate) {
            return false
        }
        let offset = if candidate.IsExtension && group.Receiver != nil {
            1
        } else {
            0
        }
        let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](candidate.Parameters.Length - offset)
        for var i = offset; i < candidate.Parameters.Length; i++ {
            if candidate.Parameters[i].RefKind != RefKind.None {
                return false
            }
            parameterTypes.Add(candidate.Parameters[i].Type)
        }
        naturalType = FunctionTypeSymbol.Get(
            parameterTypes.MoveToImmutable(),
            MethodGroupObservableReturnType(candidate)
        )
        return true
    }

    private func TryGetSymbolicUserMethodGroupType(
        group BoundMethodGroupExpression,
        expectedParameterTypes ImmutableArray[TypeSymbol],
        @NotNullWhen(true) out naturalType FunctionTypeSymbol?
    ) bool {
        naturalType = nil
        var selected FunctionSymbol? = nil
        for var pass = 0; pass < 2 && selected == nil; pass++ {
            let allowVariance = pass == 1
            for candidate in group.Candidates {
                if candidate.IsGeneric {
                    continue
                }
                let offset = if candidate.IsExtension && group.Receiver != nil {
                    1
                } else {
                    0
                }
                if candidate.Parameters.Length - offset != expectedParameterTypes.Length {
                    continue
                }
                var compatible = true
                for var i = 0; i < expectedParameterTypes.Length; i++ {
                    let candidateParameter = candidate.Parameters[i + offset]
                    let expectedParameter = expectedParameterTypes[i]
                    if candidateParameter.RefKind != RefKind.None ||
                        (
                        !DeclarationBinder.TypeSignaturesEquivalent(expectedParameter, candidateParameter.Type) &&
                            (
                            !allowVariance || !Conversion.ClassifyNonStructural(
                                expectedParameter,
                                candidateParameter.Type
                            )
                                .IsImplicit
                        )
                    ) {
                        compatible = false
                        break
                    }
                }
                if !compatible {
                    continue
                }
                if selected != nil {
                    return false
                }
                selected = candidate
            }
        }
        if selected == nil {
            return false
        }
        let selectedOffset = if selected.IsExtension && group.Receiver != nil {
            1
        } else {
            0
        }
        let parameterTypes = ImmutableArray.CreateBuilder[TypeSymbol](selected.Parameters.Length - selectedOffset)
        for var i = selectedOffset; i < selected.Parameters.Length; i++ {
            parameterTypes.Add(selected.Parameters[i].Type)
        }
        naturalType = FunctionTypeSymbol.Get(
            parameterTypes.MoveToImmutable(),
            MethodGroupObservableReturnType(selected)
        )
        return true
    }

    /// Issue #3712: refines a pre-resolution symbolic argument vector once the
    /// winning CLR overload is known, replacing each user method-group slot that
    /// carries no symbolic function type with the symbolic function type of the
    /// candidate whose arity matches the target delegate parameter. The erased
    /// CLR vector resolves such a group's return type to `object` when the
    /// return type is a same-compilation user type; without this refinement the
    /// generic method is emitted closed over `object` and the assembly
    /// fails IL verification with `StackUnexpected`.
    ///
    /// Issue #3712 follow-up (instance calls): the slot is refined for a
    /// SINGLE-candidate group too. A single-candidate group only acquires a
    /// natural type when that type is expressible in CLR terms, so a group
    /// returning a same-compilation user class reaches this vector as
    /// (cref:TypeSymbol.Error) exactly like an overloaded one. The
    /// (cref:FunctionTypeSymbol) guard below keeps every slot that
    /// already carries symbolic information untouched.
    /// @param resolved The winning (possibly closed generic) CLR method.
    /// @param arguments The bound user arguments, in source order.
    /// @param symbolicArgs The pre-resolution symbolic vector, receiver-first when
    /// [`receiverArgCount`](paramref) is 1.
    /// @param receiverArgCount Number of leading receiver slots in [`symbolicArgs`](paramref).
    /// @param isExpanded Whether trailing arguments target a params-array element.
    /// @param argumentNames Optional source-slot argument names.
    /// @param parameterMapping Optional resolved source-slot to parameter-position mapping.
    /// @returns The refined vector, or [`symbolicArgs`](paramref) when nothing changed.
    private func RefineSymbolicArgsForMethodGroups(
        resolved MethodInfo,
        arguments ImmutableArray[BoundExpression],
        symbolicArgs ImmutableArray[TypeSymbol],
        receiverArgCount int32,
        isExpanded bool = false,
        argumentNames IReadOnlyList[string?]? = nil,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32])
    ) ImmutableArray[TypeSymbol] -> this
        .RefineSymbolicArgsForMethodGroups(
        resolved,
        arguments,
        symbolicArgs,
        receiverArgCount,
        isExpanded,
        argumentNames,
        parameterMapping,
        out _
    )

    /// Issue #4133 (hot-core translation guard finding): overload that also
    /// reports which slots were refined from a bare method group, so a
    /// caller feeding the result into `MemberLookup.BuildSymbolicMethodTypeArgs`
    /// can mark those slots' contribution as method-group-sourced. C#'s own
    /// method-type-inference (§12.6.3.7) never makes an INPUT inference from
    /// a method group — only an OUTPUT inference from its (eventually
    /// resolved) return type, after the other type variables are already
    /// fixed. Feeding a method group's own PARAMETER types back in as an
    /// ordinary delegate-shaped argument (exactly what this refinement does,
    /// for good reason elsewhere — see the type-recovery comment above) lets
    /// `UnifyForMethodTypeArgs`'s existing lambda-parameter unification
    /// (Issue #1334) treat that parameter type as a genuine contravariant
    /// upper bound it is not: `Where(pred)` over `IEnumerable[Item]`
    /// with `pred(x Item?) bool` then "raises" TSource from the
    /// receiver's true `Item` to `Item?`, matching #4133's own
    /// mechanism for a case it was never meant to cover.
    private func RefineSymbolicArgsForMethodGroups(
        resolved MethodInfo,
        arguments ImmutableArray[BoundExpression],
        symbolicArgs ImmutableArray[TypeSymbol],
        receiverArgCount int32,
        isExpanded bool,
        argumentNames IReadOnlyList[string?]?,
        parameterMapping ImmutableArray[int32],
        out methodGroupSlots ImmutableArray[bool]
    ) ImmutableArray[TypeSymbol] {
        methodGroupSlots = default(ImmutableArray[bool])
        if symbolicArgs.IsDefaultOrEmpty || arguments.IsDefaultOrEmpty {
            return symbolicArgs
        }
        let parameters = resolved.GetParameters()
        let paramsIndex = parameters.Length - 1
        let openMethod = if resolved.IsGenericMethod {
            resolved.GetGenericMethodDefinition()
        } else {
            resolved
        }
        let openParameters = openMethod.GetParameters()
        let partialMethodTypeArgs = if resolved.IsGenericMethod {
            MemberLookup.BuildSymbolicMethodTypeArgs(
                resolved,
                default(ImmutableArray[TypeSymbol]),
                symbolicArgs,
                isExpanded,
                argumentNames
            )
        } else {
            default(ImmutableArray[TypeSymbol?])
        }
        var effectiveParameterMapping = parameterMapping
        if effectiveParameterMapping.IsDefault && ClrOverloadResolution.TryBuildNamedArgumentReordering(
            openMethod,
            symbolicArgs.Length,
            argumentNames,
            isExpanded,
            out var namedMapping
        ) {
            effectiveParameterMapping = ImmutableArray.Create(namedMapping)
        }
        var refined ImmutableArray[TypeSymbol].Builder? = nil
        var methodGroupSlotsBuilder ImmutableArray[bool].Builder? = nil
        for var i = 0; i < arguments.Length; i++ {
            let slot = i + receiverArgCount
            var parameterIndex = if !effectiveParameterMapping.IsDefault && slot < effectiveParameterMapping.Length {
                effectiveParameterMapping[slot]
            } else {
                slot
            }
            parameterIndex = if isExpanded &&
                paramsIndex >= 0 &&
                parameterIndex >= paramsIndex &&
                ClrOverloadResolution.IsParamsArrayParameter(parameters[paramsIndex]) {
                paramsIndex
            } else {
                parameterIndex
            }
            if slot >= symbolicArgs.Length || parameterIndex < 0 || parameterIndex >= parameters.Length {
                continue
            }
            if arguments[i] is not BoundMethodGroupExpression group {
                continue
            }
            if symbolicArgs[slot] is FunctionTypeSymbol {
                continue
            }
            // Issue #3752/#3753: read the target delegate's shape through the
            // load-context funnel rather than a bare `Invoke` probe — the
            // direct probe throws (and would silently skip the refinement)
            // whenever the closed delegate is a `TypeBuilderInstantiation`,
            // which is exactly what closing `Converter`/`Func` over a
            // MetadataLoadContext type argument produces.
            var parameterType = parameters[parameterIndex].ParameterType
            if isExpanded && parameterIndex == paramsIndex && parameterType.GetElementType() is {} elementType {
                parameterType = elementType
            }
            var targetParameterTypes = default(ImmutableArray[TypeSymbol])
            if !partialMethodTypeArgs.IsDefaultOrEmpty && parameterIndex < openParameters.Length {
                var openParameterType = openParameters[parameterIndex].ParameterType
                if isExpanded &&
                    parameterIndex == paramsIndex &&
                    openParameterType.GetElementType() is {} openElementType {
                    openParameterType = openElementType
                }
                let symbolicTarget = MemberLookup.MapOpenSignatureWithoutDeclarationMerge(
                    openParameterType,
                    openDefinition: nil,
                    typeArguments: default(ImmutableArray[TypeSymbol]),
                    openMethodDefinition: if resolved.IsGenericMethod {
                        openMethod
                    } else {
                        default(MethodInfo?)
                    },
                    methodTypeArguments: partialMethodTypeArgs
                )
                if MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(symbolicTarget, out var targetFunctionType) {
                    targetParameterTypes = targetFunctionType.ParameterTypes
                }
            }
            if !ClrLoadContext.TryGetDelegateSignature(parameterType, out var delegateParameters, out _) {
                continue
            }
            var symbolicGroupType FunctionTypeSymbol?
            let recovered = if !targetParameterTypes.IsDefault {
                TryGetSymbolicUserMethodGroupType(group, targetParameterTypes, out symbolicGroupType)
            } else {
                TryGetSymbolicUserMethodGroupType(group, out symbolicGroupType, delegateParameters.Length)
            }
            if !recovered || symbolicGroupType == nil {
                continue
            }
            refined ??= symbolicArgs.ToBuilder()
            refined!![slot] = symbolicGroupType
            methodGroupSlotsBuilder ??= ImmutableArray.CreateBuilder[bool](symbolicArgs.Length)
            while methodGroupSlotsBuilder!!.Count < symbolicArgs.Length {
                methodGroupSlotsBuilder!!.Add(false)
            }
            methodGroupSlotsBuilder!![slot] = true
        }
        methodGroupSlots = methodGroupSlotsBuilder?.MoveToImmutable() ?? default(ImmutableArray[bool])
        return refined?.ToImmutable() ?? symbolicArgs
    }

    /// ADR-0055 Tier 4: lowers an interpolated string whose contextual target
    /// type is (cref:System.IFormattable) or
    /// (cref:System.FormattableString) to
    /// `FormattableStringFactory.Create(format, object[])`, preserving the
    /// composite format string (alignment/format clauses included) so the caller
    /// can defer formatting and choose a culture at consumption time. The result
    /// is a (cref:System.FormattableString) value, which is reference-
    /// compatible with an (cref:System.IFormattable) target.
    internal func BindInterpolatedStringAsFormattable(
        syntax InterpolatedStringExpressionSyntax,
        targetType TypeSymbol?
    ) BoundExpression {
        if !TryBuildInterpolationFormat(syntax, out var composite, out var holeValues) {
            return BoundErrorExpression(nil)
        }
        let formatLiteral = BoundLiteralExpression(
            nil,
            Invariant.Required(
                composite,
                "a successful interpolation format has a composite string",
                expression: "composite"
            )
        )
        let argArray = BuildObjectArgumentArray(holeValues)
        let factoryType = typeof(FormattableStringFactory)
        let createMethod = Invariant.Required(
            factoryType.GetMethod("Create", []Type{typeof(string), typeof([]object)}),
            "FormattableStringFactory.Create has the expected signature",
            expression: "factoryType.GetMethod(\"Create\", new[] { typeof(string), typeof(object[]) })"
        )
        let importedClass = ImportedClassSymbol(factoryType, declaration: nil)
        let importedFn = ImportedFunctionSymbol(createMethod.Name, importedClass, createMethod, declaration: nil)
        return BoundImportedCallExpression(
            nil,
            importedFn,
            ImmutableArray.Create[BoundExpression](formatLiteral, argArray)
        )
    }

    /// ADR-0055 Tier 4 (#369): after overload resolution selects an imported
    /// method/constructor, re-lowers each interpolated-string argument whose
    /// chosen parameter type is `IFormattable`/`FormattableString` to
    /// `FormattableStringFactory.Create(...)`. Arguments bound against any
    /// other parameter (including `string`) are left untouched. Returns the
    /// original array unchanged when nothing needs re-lowering.
    /// Issue #1638: `receiverArgCount` is the number of leading argument
    /// slots reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls, which prepend the receiver to both
    /// `arguments` and `parameters` but not to `argumentSyntax`).
    /// Receiver slots are skipped since they have no source syntax to re-lower.
    private func RebindFormattableInterpolationArguments(
        arguments ImmutableArray[BoundExpression],
        argumentSyntax GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        parameters[]ParameterInfo,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32]),
        receiverArgCount int32 = 0,
        isExpanded bool = false
    ) ImmutableArray[BoundExpression] {
        var builder ImmutableArray[BoundExpression].Builder? = nil
        let limit = Math.Min(arguments.Length, argumentSyntax.Count + receiverArgCount)
        let paramsIndex = parameters.Length - 1
        for var i = receiverArgCount; i < limit; i++ {
            let paramIndex = if parameterMapping.IsDefault {
                (
                    if isExpanded && i >= paramsIndex {
                        paramsIndex
                    } else {
                        i
                    }
                )
            } else {
                parameterMapping[i]
            }
            if paramIndex >= parameters.Length {
                continue
            }
            let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i - receiverArgCount])
            var targetType = parameters[paramIndex].ParameterType
            if isExpanded && paramIndex == paramsIndex && ClrOverloadResolution.IsParamsArrayParameter(
                parameters[paramIndex]
            ) &&
                targetType.GetElementType() is {} elementType {
                targetType = elementType
            }
            if argSyntax is InterpolatedStringExpressionSyntax interpolated &&
                ClrOverloadResolution
                .IsFormattableStringTarget(targetType) {
                builder ??= arguments.ToBuilder()
                builder!![i] = BindInterpolatedStringAsFormattable(interpolated, targetType: nil)
            }
        }
        return builder?.ToImmutable() ?? arguments
    }

    /// Builds the C#-style composite format string (`"{0}"`,
    /// `"{0,10}"`, `"{0,-20:N2}"`) and the ordered, bound hole values
    /// for an interpolated string. Literal braces are escaped (`{` →
    /// `{{`) so they survive `String.Format`/`FormattableString`
    /// formatting. Returns `false` if any hole fails to bind.
    private func TryBuildInterpolationFormat(
        syntax InterpolatedStringExpressionSyntax,
        out composite string?,
        out holeValues ImmutableArray[BoundExpression]
    ) bool {
        composite = nil
        holeValues = default(ImmutableArray[BoundExpression])
        let format = StringBuilder()
        let values = ImmutableArray.CreateBuilder[BoundExpression]()
        for segment in syntax.Segments {
            if !segment.IsExpression {
                AppendEscapedLiteral(format, segment.Text ?? string.Empty)
                continue
            }
            let segmentExpression = Invariant.Required(
                segment.Expression,
                "an interpolation segment has an expression",
                expression: "segment.Expression"
            )
            let bound = BindExpression(segmentExpression)
            if bound is BoundErrorExpression {
                return false
            }
            let index = values.Count
            values.Add(bound)
            format.Append('{').Append(index.ToString(CultureInfo.InvariantCulture))
            if (segment.Alignment != nil) {
                format.Append(',').Append(segment.Alignment.ToString(CultureInfo.InvariantCulture))
            }
            if segment.Format != nil {
                format.Append(':').Append(segment.Format)
            }
            format.Append('}')
        }
        composite = format.ToString()
        holeValues = values.ToImmutable()
        return true
    }

    /// Wraps the bound hole values in an `object[]` creation, boxing value
    /// types via an explicit conversion to `object` so the emitter produces
    /// verifiable IL (ADR-0055 — no `Convert.ToString` mis-typing).
    private func BuildObjectArgumentArray(holeValues ImmutableArray[BoundExpression]) BoundExpression {
        let elements = ImmutableArray.CreateBuilder[BoundExpression](holeValues.Length)
        for value in holeValues {
            elements.Add(
                if value.Type == TypeSymbol.Object {
                    value
                } else {
                    cast[BoundExpression](BoundConversionExpression(nil, TypeSymbol.Object, value))
                }
            )
        }
        let arrayType = ArrayTypeSymbol.Get(TypeSymbol.Object, holeValues.Length)
        return BoundArrayCreationExpression(nil, arrayType, elements.ToImmutable())
    }

    private func BuildStringFormatCall(composite string, holeValues ImmutableArray[BoundExpression]) BoundExpression {
        let formatLiteral = BoundLiteralExpression(nil, composite)
        let argArray = BuildObjectArgumentArray(holeValues)
        let stringType = typeof(string)
        let formatMethod = Invariant.Required(
            stringType.GetMethod("Format", []Type{typeof(string), typeof([]object)}),
            "string.Format has the expected signature",
            expression: "stringType.GetMethod(\"Format\", new[] { typeof(string), typeof(object[]) })"
        )
        let importedClass = ImportedClassSymbol(stringType, declaration: nil)
        let importedFn = ImportedFunctionSymbol(formatMethod.Name, importedClass, formatMethod, declaration: nil)
        return BoundImportedCallExpression(
            nil,
            importedFn,
            ImmutableArray.Create[BoundExpression](formatLiteral, argArray)
        )
    }

    private func ConvertToString(expression BoundExpression, diagnosticLocation TextLocation) BoundExpression {
        if expression.Type == TypeSymbol.String {
            return expression
        }
        let clrType Type? = expression.Type?.ClrType
        if clrType == nil {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type ?? TypeSymbol.Error, TypeSymbol.String)
            return BoundErrorExpression(nil)
        }
        // Bind a call to `System.Convert.ToString(<expr.Type>)`. Convert.ToString
        // is a static overload set covering every primitive (int, long, bool,
        // double, ...) plus `object`, so it works uniformly without emitter
        // changes for value-type instance dispatch.
        let convertType = typeof(Convert)
        let method MethodInfo? = convertType.GetMethod("ToString", []Type{clrType}) ?? convertType.GetMethod(
            "ToString",
            []Type{typeof(object)}
        )
        if method == nil {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type ?? TypeSymbol.Error, TypeSymbol.String)
            return BoundErrorExpression(nil)
        }
        let importedClass = ImportedClassSymbol(convertType, declaration: nil)
        let importedFn = ImportedFunctionSymbol(method.Name, importedClass, method, declaration: nil)
        return BoundImportedCallExpression(nil, importedFn, ImmutableArray.Create(expression))
    }

    /// Binds an anonymous-class literal `object { let Name = "Foo"; ... }`
    /// (issue #2224 / ADR-0146). Unlike (cref:BindStructLiteralExpression(StructLiteralExpressionSyntax)),
    /// there is no named type to resolve: each distinct ordered
    /// (member-name, member-type) shape gets its own compiler-synthesized
    /// backing (cref:StructSymbol), cached per compile pass (see
    /// (cref:AnonymousTypeCache)) so two literals with the same shape
    /// share one synthesized type — mirroring how Roslyn unifies
    /// `new { ... }` anonymous types within one C# compilation. Unlike
    /// C#, each member's type is written explicitly rather than inferred from
    /// its initializer expression; the annotated type is checked against the
    /// initializer exactly like an ordinary `let x Type = expr`
    /// declaration's type clause
    /// ((cref:StatementBinder.BindVariableDeclaration(VariableDeclarationSyntax))),
    /// so implicit conversions and nullable annotations apply the same way.
    /// @param syntax The anonymous-class-literal syntax.
    private func BindAnonymousClassExpression(syntax AnonymousClassExpressionSyntax) BoundExpression {
        // ADR-0146 / issue #2243: a "rich" anonymous object — one carrying a
        // base/interface clause, methods, or events — was desugared to a
        // compiler-synthesized backing class by the pre-binding pass
        // (Binder.SynthesizeRichAnonymousClasses). Bind the literal site to a
        // parameterless construction of that class; its field initializers and
        // base-constructor forwarding run in the synthesized constructor.
        if IsRichAnonymousObject(syntax) {
            return BindRichAnonymousClassExpression(syntax)
        }
        let seenNames = HashSet[string]()
        let memberNames = ImmutableArray.CreateBuilder[string](syntax.Members.Length)
        let memberValues = ImmutableArray.CreateBuilder[BoundExpression](syntax.Members.Length)
        var hadError = false
        for memberNode in syntax.Members {
            if !(memberNode is AnonymousClassMemberInitializerSyntax member) {
                // A method/event in an object with no base clause is still a
                // rich object and handled above; reaching here means an
                // unexpected member node — skip defensively.
                continue
            }
            let name = member.Identifier.ValueText
            if !seenNames.Add(name) {
                Diagnostics.ReportSymbolAlreadyDeclared(member.Identifier.Location, name)
                hadError = true
                continue
            }
            // The member type clause is optional (ADR-0146): when present the
            // annotated type wins and the initializer is converted to it
            // (declared-type-wins, like `let x Type = expr`); when absent the
            // member type is inferred from the initializer expression exactly
            // like an ordinary `let x = expr` local declaration.
            let memberType TypeSymbol? = if member.TypeClause == nil {
                default(TypeSymbol?)
            } else {
                bindTypeClause(member.TypeClause)
            }
            let value = if memberType == nil {
                BindExpression(member.Value)
            } else {
                BindExpression(member.Value, memberType)
            }
            if value is BoundErrorExpression {
                hadError = true
            }
            memberNames.Add(name)
            memberValues.Add(value)
        }
        if hadError || memberNames.Count == 0 {
            return BoundErrorExpression(syntax)
        }
        let shape = [memberNames.Count](Name string, Type TypeSymbol)
        for var i = 0; i < memberNames.Count; i++ {
            shape[i] = (memberNames[i], memberValues[i].Type)
        }
        let packageName = this.function?.Package?.Name ?? string.Empty
        let anonymousType = $scope.GetAnonymousTypeCache().GetOrCreate(shape, packageName, useFields: syntax.IsData)
        if syntax.IsData {
            // ADR-0146 / issue #2243: a `data object { ... }` synthesizes a
            // fields-based value type (data-class style). Emit it as a
            // composite struct literal (initobj + stfld per field) exactly like
            // an ordinary `data struct Foo(x int32)` literal, so value equality,
            // ToString, Deconstruct, and `with`-copy all work off the fields.
            let initializers = ImmutableArray.CreateBuilder[BoundFieldInitializer](memberValues.Count)
            let fields = anonymousType.Fields
            for var i = 0; i < memberValues.Count; i++ {
                initializers.Add(BoundFieldInitializer(fields[i], memberValues[i]))
            }
            return BoundStructLiteralExpression(syntax, anonymousType, initializers.MoveToImmutable())
        }
        // A plain `object { ... }`'s members are get-only auto-properties with
        // no public field/setter (see AnonymousTypeCache), so it compiles as a
        // primary constructor call (`<>AnonymousTypeN(v1, v2, ...)`) — exactly
        // like C#'s `new { ... }` lowers to a constructor call. This reuses the
        // proven primary-constructor-call and expression-tree lowering paths
        // with no additional emitter code.
        return BoundConstructorCallExpression(syntax, anonymousType, memberValues.MoveToImmutable())
    }

    private func BindRichAnonymousClassExpression(syntax AnonymousClassExpressionSyntax) BoundExpression {
        // The declaration pre-pass records a stable synthesized class shell
        // for each rich literal. The Binder callback completes the literal-site
        // inference/capture/base-constructor plan and returns its exact
        // constructor call.
        if $scope.GetRichAnonymousClassMap().TryGetValue(syntax, out var classSymbol) && classSymbol != nil {
            return bindRichAnonymousObject(syntax, classSymbol)
        }
        // Defensive: if the desugaring pass produced no symbol (it reported a
        // diagnostic), surface an error node so binding continues.
        return BoundErrorExpression(syntax)
    }

    /// ADR-0180: one ordered step of a mixed composite literal's lexical
    /// lowering — either a member (`Field: value`, mirroring the
    /// pre-ADR-0180 ordered-initializer tuple) or a content element/spread
    /// (`Text("x")` / `...rows`, lowered to `Add(...)` on the
    /// constructed receiver). Kept as one discriminated list, rather than
    /// separate member/content lists, so the binder can walk
    /// (cref:StructLiteralExpressionSyntax.Elements) once, in the
    /// exact source order the ADR requires.
    private class StructLiteralOrderedStep {
        private init() { }

        prop MemberSyntax FieldInitializerSyntax? {
            get;
            private init;
        }

        prop MemberType TypeSymbol? {
            get;
            private init;
        }

        prop Braced CollectionInitializerExpressionSyntax? {
            get;
            private init;
        }

        prop Field FieldSymbol? {
            get;
            private init;
        }

        prop FieldDeclaringType StructSymbol? {
            get;
            private init;
        }

        prop Property PropertySymbol? {
            get;
            private init;
        }

        prop Content StructLiteralContentElementSyntax? {
            get;
            private init;
        }

        shared {
            func ForMember(
                syntax FieldInitializerSyntax,
                memberType TypeSymbol,
                braced CollectionInitializerExpressionSyntax?,
                field FieldSymbol?,
                fieldDeclaringType StructSymbol?,
                property PropertySymbol?
            ) StructLiteralOrderedStep -> StructLiteralOrderedStep{
                MemberSyntax: syntax,
                MemberType: memberType,
                Braced: braced,
                Field: field,
                FieldDeclaringType: fieldDeclaringType,
                Property: property
            }

            func ForContent(
                content StructLiteralContentElementSyntax
            ) StructLiteralOrderedStep -> StructLiteralOrderedStep{Content: content}
        }
    }

    private func BindStructLiteralExpression(
        syntax StructLiteralExpressionSyntax
    ) BoundExpression -> BindStructLiteralExpression(syntax, resolvedDefinition: nil)

    /// Binds a struct/class literal `Foo{ ... }`. When
    /// [`resolvedDefinition`](paramref) is supplied (issue #1174: a
    /// qualified nested type `Container.Nested{ ... }` whose simple name
    /// collides with a top-level homonym), it is used directly instead of
    /// resolving the type by the literal's simple name — which would otherwise
    /// bind to the top-level homonym holding the simple key.
    /// @param syntax The struct-literal syntax.
    /// @param resolvedDefinition The pre-resolved struct definition, or `null` to resolve by simple name.
    /// @param enclosingTypeArguments Issue #1521 / #1537: when the literal names a type nested inside a
    /// CONSTRUCTED generic enclosing type (`Outer[int32].Middle[string]{…}`
    /// or `Box[int32].Tag{…}`), the flattened enclosing construction's type
    /// arguments (outermost-first). Threaded onto the constructed struct symbol
    /// so member types substitute the enclosing arguments and the emitter
    /// encodes the reified nested type (`Outer`1+Middle`2<int32,string>`).
    private func BindStructLiteralExpression(
        syntax StructLiteralExpressionSyntax,
        resolvedDefinition StructSymbol?,
        enclosingTypeArguments ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        resolveTypeOnly bool = false
    ) BoundExpression {
        if resolvedDefinition == nil && syntax.TypeArgumentList is {} nativeTypeArguments {
            if CanUseSpanAlias(syntax.TypeIdentifier, expression: true) {
                return RejectNativeSpanAllocation(syntax)
            }
            if binderCtx.CanUseNativeBufferAlias(
                $scope,
                syntax.TypeIdentifier,
                getCurrentFunction(),
                expression: true
            ) {
                return BindEmptyNativeBufferLiteral(syntax, nativeTypeArguments)
            }
        }
        if syntax.SpreadExpression != nil {
            return BindStructuralSpreadLiteral(syntax, resolvedDefinition, enclosingTypeArguments)
        }
        let typeName = syntax.TypeIdentifier.ValueText
        var structSymbol StructSymbol? = nil
        if resolvedDefinition != nil {
            structSymbol = resolvedDefinition
        } else {
            // Issue #1051: when the literal carries an explicit type-argument list,
            // resolve the same-named generic definition of the matching arity so a
            // non-generic `Foo` and a generic `Foo[T]` can coexist. Without one,
            // prefer the arity-0 type (falling back to a lone generic for inference).
            let preferredArity = if syntax.TypeArgumentList != nil {
                syntax.TypeArgumentList!!.Arguments.Count
            } else {
                -1
            }
            let foundAlias = binderCtx.TryLookupSourceType(
                $scope,
                typeName,
                preferredArity,
                getCurrentFunction(),
                out var resolvedType,
                out var typeNameAmbiguous
            )
            let resolvedStruct StructSymbol? = resolvedType as StructSymbol
            var importedCandidate ImportedClassSymbol? = nil
            var importedAmbiguity ImportedTypeAmbiguity? = nil
            let hasImportedCandidate = !typeNameAmbiguous && $scope.TryLookupImportedClassByArity(
                typeName,
                preferredArity,
                declaration: nil,
                out importedCandidate,
                out importedAmbiguity
            )
            // Issue #3466: a nested source type may retain the bare (name,
            // arity) key for references from its containing type. Outside that
            // lexical scope, an explicit alias or same-named top-level CLR
            // import wins; inside it, the nested source type retains its
            // existing short-name meaning.
            let importedTypeTakesPrecedence = foundAlias &&
                resolvedStruct != nil &&
                hasImportedCandidate &&
                importedCandidate != nil &&
                binderCtx
                .ImportedTypeOverridesSourceType(
                $scope,
                typeName,
                resolvedStruct,
                preferredArity,
                getCurrentFunction(),
                importedCandidate.ClassType
            )
            if !foundAlias || resolvedStruct == nil || importedTypeTakesPrecedence {
                if importedAmbiguity != nil {
                    Diagnostics.ReportAmbiguousImportedTypeReference(
                        syntax.TypeIdentifier.Location,
                        typeName,
                        importedAmbiguity
                    )
                    return BoundErrorExpression(syntax)
                }
                // Issue #1199 / #2258: a composite literal `T{Field: value}` also
                // targets an IMPORTED reference-type class (a BCL class such as
                // `System.Text.Json.JsonSerializerOptions`) or an imported
                // value-type struct (`System.Text.Json.JsonWriterOptions`). These
                // resolve through the import table — not `TryLookupTypeAlias`,
                // which only surfaces user-declared types — so route the literal
                // through the same imported-class lookup that the
                // constructor-call path uses and lower it to a C#-style
                // object-initializer (construct via the parameterless
                // constructor, or the zero value for a value type with none,
                // then assign each named member).
                //
                // Issue #2455: when `typeNameAmbiguous` is set, two or more
                // colliding SOURCE packages are each imported and neither of
                // the fallbacks below (imported CLR class, type parameter) can
                // possibly be what the literal means — skip straight to
                // reporting the dedicated ambiguity diagnostic rather than the
                // generic "cannot find type".
                if syntax.TypeArgumentList == nil &&
                    hasImportedCandidate &&
                    importedCandidate != nil &&
                    importedCandidate.ClassType is {IsGenericTypeDefinition: false} {
                    if ImportedTypeSymbol.TryCreateSemanticAggregate(
                        importedCandidate.ClassType,
                        $scope.References,
                        out var importedAggregate
                    ) {
                        structSymbol = importedAggregate
                    } else {
                        return BindImportedTypeLiteralExpression(
                            syntax,
                            importedCandidate.ClassType,
                            resolveTypeOnly: resolveTypeOnly
                        )
                    }
                } else if syntax.TypeArgumentList != nil &&
                    hasImportedCandidate &&
                    importedCandidate != nil &&
                    importedCandidate
                    .ClassType
                    .IsGenericTypeDefinition &&
                    TryResolveClrConstructionTypeArgs(
                    syntax.TypeArgumentList!!,
                    out var clrTypeArguments,
                    out var literalSymbolicArguments,
                    out var hasSymbolicArgument
                ) {
                    // Issue #4032 (review finding 1): the literal spelling
                    // `Handler[string]{Tag: "z"}` closes the imported generic here
                    // and did not ask the constraints. Measured: it emitted an
                    // instantiation the CLR refuses and threw TypeLoadException.
                    if Binder.ReportUnsatisfiedGenericTypeConstraint(
                        Diagnostics,
                        importedCandidate.ClassType,
                        clrTypeArguments,
                        literalSymbolicArguments,
                        syntax.TypeIdentifier.Location
                    ) {
                        return BoundErrorExpression(nil)
                    }
                    var closedImportedType Type
                    try {
                        closedImportedType = importedCandidate.ClassType.MakeGenericType(clrTypeArguments)
                    } catch (ArgumentException) {
                        Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName)
                        return BoundErrorExpression(nil)
                    }
                    if ImportedTypeSymbol.TryCreateSemanticAggregate(
                        closedImportedType,
                        $scope.References,
                        out var dataClass
                    ) &&
                        dataClass is StructSymbol{IsClass: true} importedDataClass {
                        return BindImportedDataClassLiteral(
                            syntax,
                            closedImportedType,
                            ImportedTypeSymbol.GetConstructed(
                                closedImportedType,
                                importedCandidate.ClassType,
                                literalSymbolicArguments
                            ),
                            importedDataClass
                        )
                    }
                    // Issue #4042: a RETAINED symbolic argument with no faithful
                    // closed CLR type of its own — a same-compilation user class
                    // or an in-scope type parameter — closes over the `object`
                    // SURROGATE, so `closedImportedType` is `Handler<object>` and
                    // neither the semantic aggregate nor a plain
                    // `TypeSymbol.FromClrType` may stand for it: the emitter has
                    // to reify `Handler<MyOptions>`. Carry the symbolic vector
                    // beside the erased shape, exactly as the CONSTRUCTOR
                    // spelling has since #671 — that is what makes
                    // `Handler[MyOptions]()` work while
                    // `Handler[MyOptions]{Tag: "z"}` reported GS0157 "Cannot find
                    // type Handler", because the whole branch used to be gated
                    // on the argument being CLR-faithful.
                    //
                    // The LOSSY-BUT-REAL family (#4024's `[]T`, #3962's `[N]T`,
                    // ADR-0172's named tuple) is untouched: those have a real
                    // closed CLR type, `HasOnlyClrFaithfulSymbolicArguments` says
                    // so, and they keep taking the plain path below.
                    if hasSymbolicArgument && !HasOnlyClrFaithfulSymbolicArguments(literalSymbolicArguments) {
                        return BindImportedTypeLiteralExpression(
                            syntax,
                            closedImportedType,
                            ImportedTypeSymbol.GetConstructed(
                                closedImportedType,
                                importedCandidate.ClassType,
                                literalSymbolicArguments
                            ),
                            resolveTypeOnly
                        )
                    }
                    if ImportedTypeSymbol.TryCreateSemanticAggregate(
                        closedImportedType,
                        $scope.References,
                        out var importedAggregate
                    ) {
                        return BindStructLiteralExpression(syntax, importedAggregate, resolveTypeOnly: resolveTypeOnly)
                    }
                    return BindImportedTypeLiteralExpression(
                        syntax,
                        closedImportedType,
                        resolveTypeOnly: resolveTypeOnly
                    )
                } else if !typeNameAmbiguous &&
                    syntax.TypeArgumentList == nil &&
                    lookupType(typeName) is TypeParameterSymbol tpLiteral {
                    // Issue #988 / #1235 (object-initializer follow-up): `T{Field: value,
                    // ...}` constructs the type parameter `T` — mirroring C#'s
                    // `new T { Field = value }` for a generic method constrained
                    // `where T : class, new()` — when the enclosing generic declares
                    // the `init()` default-constructor constraint. Lowered to a
                    // reified `Activator.CreateInstance<T>()` construction followed by
                    // member assignments through the constraint's field/property
                    // surface (see BindTypeParameterObjectInitializer).
                    if !tpLiteral.HasDefaultConstructorConstraint {
                        Diagnostics.ReportConstructedTypeParameterRequiresNewConstraint(
                            syntax.TypeIdentifier.Location,
                            tpLiteral.Name
                        )
                        for initSyntax in syntax.Initializers {
                            let _ = BindExpression(initSyntax.Value)
                        }
                        return BoundErrorExpression(nil)
                    }
                    return BindTypeParameterObjectInitializer(syntax, tpLiteral)
                } else if structSymbol == nil && typeNameAmbiguous {
                    Diagnostics.ReportAmbiguousSourceType(syntax.TypeIdentifier.Location, typeName)
                    return BoundErrorExpression(nil)
                } else if structSymbol == nil {
                    Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName)
                    return BoundErrorExpression(nil)
                }
            } else {
                structSymbol = resolvedStruct
            }
        }
        structSymbol = Invariant.Required(
            structSymbol,
            "a valid struct literal resolves to a struct symbol",
            expression: "structSymbol"
        )
        // ADR-0047 §6 / #175: struct/class literal `Foo{ ... }` is a
        // use of the named type.
        reportObsoleteUseIfApplicable(syntax.TypeIdentifier.Location, structSymbol, structSymbol.Name)
        // ADR-0195 / issue #4674: an `abstract` or `shared` class cannot be
        // constructed, whichever way it is spelled — `Foo()` reports GS0386
        // from the constructor-call path, and the composite literal `Foo{}`
        // must not slip past it into a `newobj` on an abstract type.
        if structSymbol.IsDeclaredAbstract || structSymbol.IsSharedClass {
            Diagnostics.ReportCannotInstantiateAbstractType(syntax.TypeIdentifier.Location, structSymbol.Name)
            return BoundErrorExpression(syntax)
        }
        // Phase 4.3 / ADR-0020: if the declared struct is generic, build a
        // type-argument substitution (explicit or inferred from initializers)
        // and construct a closed StructSymbol to bind against. Constructed
        // instances are cached so reference-equality of TypeSymbols is
        // preserved (e.g. `Result[int, string]` always returns the same
        // StructSymbol object).
        if structSymbol.IsGenericDefinition {
            let substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
            let tps = structSymbol.TypeParameters
            if syntax.TypeArgumentList != nil {
                let explicitArgs = syntax.TypeArgumentList!!.Arguments
                if explicitArgs.Count != tps.Length {
                    Diagnostics.ReportWrongTypeArgumentCount(
                        syntax.TypeArgumentList!!.Location,
                        typeName,
                        tps.Length,
                        explicitArgs.Count
                    )
                    return BoundErrorExpression(nil)
                }
                for var i = 0; i < explicitArgs.Count; i++ {
                    let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                    if ta == nil {
                        return BoundErrorExpression(nil)
                    }
                    substitution[tps[i]] = ta
                }
            } else {
                // Infer from the initializer expression types matched against
                // the corresponding field's declared type (first-seen wins,
                // consistent with Phase 4.1 call-site inference).
                for initSyntax in syntax.Initializers {
                    var memberType TypeSymbol
                    if TypeMemberModel.TryGetFieldIncludingInherited(
                        structSymbol,
                        initSyntax.FieldIdentifier.ValueText,
                        MemberQuery.Instance(MemberKinds.Field),
                        out var field,
                        out _
                    ) {
                        memberType = field.Type
                    } else if TypeMemberModel.TryGetProperty(
                        structSymbol,
                        initSyntax.FieldIdentifier.ValueText,
                        out var property
                    ) {
                        memberType = property.Type
                    } else {
                        continue
                    }
                    // Concrete members cannot constrain this construction's
                    // type arguments; bind them once in the final closed pass.
                    if !TypeSymbol.ContainsTypeParameter(memberType) {
                        continue
                    }
                    let valueExpr = BindExpression(initSyntax.Value)
                    Binder.InferTypeArguments(memberType, valueExpr.Type, substitution)
                }
                for tp in tps {
                    if !substitution.ContainsKey(tp) {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.TypeIdentifier.Location, typeName, tp.Name)
                        return BoundErrorExpression(nil)
                    }
                }
            }
            // Phase 4.2 constraint satisfaction.
            let constraintLocation = if syntax.TypeArgumentList != nil {
                syntax.TypeArgumentList!!.Location
            } else {
                syntax.TypeIdentifier.Location
            }
            for tp in tps {
                let typeArg = substitution[tp]
                if !Binder.SatisfiesConstraint(typeArg, tp, substitution) {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                        constraintLocation,
                        tp.Name,
                        typeArg,
                        Binder.DescribeConstraint(tp)
                    )
                    return BoundErrorExpression(nil)
                }
            }
            let typeArgs = ImmutableArray.CreateBuilder[TypeSymbol](tps.Length)
            for tp in tps {
                typeArgs.Add(substitution[tp])
            }
            // Issue #1537: a generic nested type of a constructed generic
            // enclosing type (`Outer[int32].Middle[string]{…}`) threads BOTH the
            // enclosing arguments and its own arguments so member types
            // substitute both levels and the emitter encodes the reified nested
            // type (`Outer`1+Middle`2<int32, string>`).
            structSymbol = if enclosingTypeArguments.IsDefaultOrEmpty {
                StructSymbol.Construct(
                    structSymbol,
                    typeArgs.MoveToImmutable(),
                    $scope.References!!.MapClrTypeToReferences
                )
            } else {
                StructSymbol.ConstructNestedGeneric(
                    structSymbol,
                    enclosingTypeArguments,
                    typeArgs.MoveToImmutable(),
                    $scope.References!!.MapClrTypeToReferences
                )
            }
        } else if syntax.TypeArgumentList != nil && structSymbol!!.ClrType is not{IsConstructedGenericType: true} {
            Diagnostics.ReportWrongTypeArgumentCount(
                syntax.TypeArgumentList!!.Location,
                typeName,
                0,
                syntax.TypeArgumentList!!.Arguments.Count
            )
            return BoundErrorExpression(nil)
        } else if !enclosingTypeArguments.IsDefaultOrEmpty {
            // Issue #1521: a NON-generic nested type of a constructed generic
            // enclosing type (`Box[int32].Tag{…}`) threads only the enclosing
            // arguments so member types typed as an enclosing parameter surface
            // closed and the emitter encodes `Box`1+Tag`1<int32>`.
            structSymbol = StructSymbol.ConstructNested(
                structSymbol,
                enclosingTypeArguments,
                $scope.References!!.MapClrTypeToReferences
            )
        }
        if resolveTypeOnly {
            return BoundDefaultExpression(syntax, structSymbol!!)
        }
        // ADR-0180: a bare content element or `...source` content spread
        // lowers to Add(...)/Add(item) on the constructed receiver, exactly
        // like ADR-0117's collection-initializer elements — so the same
        // "does the target expose an accessible Add" gate applies here,
        // reusing ADR-0117's own GS0369 diagnostic rather than a new one.
        var hasBareContentElement = false
        var hasSpreadContentElement = false
        for scanElement in syntax.Elements {
            if scanElement is not StructLiteralContentElementSyntax scanContent {
                continue
            }
            if scanContent.Expression is SpreadElementExpressionSyntax {
                hasSpreadContentElement = true
            } else {
                hasBareContentElement = true
            }
        }
        let hasContentElement = hasBareContentElement || hasSpreadContentElement
        if (hasBareContentElement && !HasCollectionAdd(structSymbol!!)) ||
            (hasSpreadContentElement && !HasUnaryCollectionAdd(structSymbol!!)) {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, structSymbol!!)
            for badElement in syntax.Elements {
                switch badElement {
                    case StructLiteralContentElementSyntax{Expression: SpreadElementExpressionSyntax badSpread} {
                        let _ = BindExpression(badSpread.Expression)
                    }
                    case badContent is StructLiteralContentElementSyntax {
                        let _ = BindExpression(badContent.Expression)
                    }
                    case badField is FieldInitializerSyntax {
                        let _ = BindExpression(badField.Value)
                    }
                }
            }
            return BoundErrorExpression(nil)
        }
        let seenFieldNames = HashSet[string]()
        var inits = ImmutableArray.CreateBuilder[BoundFieldInitializer]()
        let callsDataConstructor = structSymbol!!.UsesConstructorOwnedDataConstruction
        let callsPrimary = BoundStructLiteralExpression.UsesPrimaryConstructor(structSymbol!!)
        if !BoundStructLiteralExpression.ValidateDataConstructor(
            structSymbol!!,
            Diagnostics,
            syntax,
            this.function,
            structSymbol!!.ClrType is {} constructorType && binderCtx.References.CanAccessInternalMembers(
                constructorType.Assembly
            )
        ) {
            return BoundErrorExpression(syntax)
        }
        let orderedInitializers List[StructLiteralOrderedStep]? = if hasContentElement || syntax.Initializers.Any(
            (initializer FieldInitializerSyntax) -> (
                initializer.Value is CollectionInitializerExpressionSyntax and {Target: nil}
            )
        ) {
            List[StructLiteralOrderedStep]()
        } else {
            default(List[StructLiteralOrderedStep]?)
        }
        for element in syntax.Elements {
            if element is StructLiteralContentElementSyntax contentElement {
                // orderedInitializers is non-null here: hasContentElement (computed
                // above from this same syntax.Elements) is one of the two conditions
                // that allocates it just above, and this branch only runs when a
                // StructLiteralContentElementSyntax is actually present.
                orderedInitializers!!.Add(StructLiteralOrderedStep.ForContent(contentElement))
                continue
            }
            let initSyntax = cast[FieldInitializerSyntax](element)
            let fieldName = initSyntax.FieldIdentifier.ValueText
            // Issue #1211: a composite literal targets `var` fields AND settable
            // `prop` auto-properties (a property with a `set` or `init`
            // accessor). Resolve fields first, then fall back to properties so
            // both `class C { var X int32 }` and `class C { prop X int32 { get;
            // init; } }` accept `C{X: ...}`.
            let hasField = TypeMemberModel.TryGetFieldIncludingInherited(
                structSymbol!!,
                fieldName,
                MemberQuery.Instance(MemberKinds.Field),
                out var field,
                out var fieldDeclaringType
            )
            var property PropertySymbol? = nil
            var propertyDeclaringType StructSymbol? = nil
            if !hasField {
                if !TypeMemberModel.TryGetProperty(structSymbol!!, fieldName, out property, out propertyDeclaringType) {
                    Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName)
                    continue
                }
            }
            // Issue #2059: a composite/struct literal `Foo{ member: value }`
            // writes the member directly, bypassing normal assignment binding
            // — so it must enforce the SAME `private`/`protected` accessibility
            // rule as a qualified write (`receiver.field = value`, #2044/#2048).
            // This is independent of the get-only/init "is it writable at all"
            // check below; an inaccessible member is rejected here even when it
            // otherwise has a setter.
            let usesGetter = (initSyntax.Value is CollectionInitializerExpressionSyntax and {Target: nil})
            let memberAccessibility = if hasField {
                Invariant.Required(field, "a resolved field has a symbol", expression: "field").Accessibility
            } else {
                (
                    if usesGetter {
                        Invariant.Required(property, "a resolved property has a symbol", expression: "property")
                            .GetterAccessibility
                    } else {
                        Invariant.Required(property, "a resolved property has a symbol", expression: "property")
                            .SetterAccessibility
                    }
                )
            }
            let memberDeclaringType = if hasField {
                fieldDeclaringType
            } else {
                propertyDeclaringType
            }
            let memberType = if hasField {
                Invariant.Required(field, "a resolved field has a type", expression: "field").Type
            } else {
                Invariant.Required(property, "a resolved property has a type", expression: "property").Type
            }
            let primaryMember Symbol? = if callsPrimary {
                BoundStructLiteralExpression.GetPrimaryMember(structSymbol!!, fieldName)
            } else {
                default(Symbol?)
            }
            let consumesPrimaryArgument = primaryMember != nil && (field == primaryMember || property == primaryMember)
            let inputType = if consumesPrimaryArgument {
                structSymbol!!
                    .PrimaryConstructorParameters
                    .First((parameter ParameterSymbol) -> parameter.Name == fieldName)
                    .Type
            } else {
                memberType
            }
            if !AccessibilityChecker.IsAccessible(
                memberAccessibility,
                Invariant.Required(
                    memberDeclaringType,
                    "a resolved member has a declaring type",
                    expression: "memberDeclaringType"
                ),
                this.function
            ) {
                Diagnostics.ReportMemberInaccessible(
                    initSyntax.FieldIdentifier.Location,
                    fieldName,
                    Invariant.Required(
                        memberDeclaringType,
                        "a resolved member has a declaring type",
                        expression: "memberDeclaringType"
                    )
                        .Name,
                    memberAccessibility
                )
                if initSyntax.Value is CollectionInitializerExpressionSyntax{Target: nil} inaccessibleCollection {
                    BindCollectionElementsForDiagnostics(inaccessibleCollection)
                } else {
                    let _ = BindExpression(initSyntax.Value, memberType)
                }
                continue
            }
            if hasField &&
                (!callsDataConstructor || (orderedInitializers != nil && !usesGetter)) &&
                !consumesPrimaryArgument &&
                !BoundStructLiteralExpression.CanWriteInitializerField(fieldDeclaringType ?? structSymbol!!, field!!) &&
                (!usesGetter || !structSymbol!!.IsClass) {
                Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, fieldName)
                seenFieldNames.Add(fieldName)
                if initSyntax.Value is CollectionInitializerExpressionSyntax{Target: nil} readonlyCollection {
                    BindCollectionElementsForDiagnostics(readonlyCollection)
                } else {
                    let _ = BindExpression(initSyntax.Value, memberType)
                }
                continue
            }
            // Issue #1567: a braced member value `Member: { a, b }` populates the
            // collection member by lowering to `.Add(...)` calls on the
            // constructed receiver's `Member` (the C# collection-initializer-in-
            // object-initializer pattern). It applies to get-only AND settable
            // collection members alike — C# always uses Add semantics for the
            // `= { … }` form — so it is handled before the get-only check. The
            // Add lowering is deferred until after the literal is constructed
            // (below), where a receiver to read `Member` from exists.
            if initSyntax.Value is CollectionInitializerExpressionSyntax{Target: nil} bracedMemberInit {
                if !seenFieldNames.Add(fieldName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName)
                    continue
                }
                orderedInitializers!!.Add(
                    StructLiteralOrderedStep.ForMember(
                        initSyntax,
                        memberType,
                        bracedMemberInit,
                        field,
                        fieldDeclaringType,
                        property
                    )
                )
                continue
            }
            // A get-only property (no `set` and no `init` accessor) cannot be
            // assigned in a composite literal — keep it diagnosed.
            if !hasField && !(callsDataConstructor && consumesPrimaryArgument) && !Invariant.Required(
                property,
                "a resolved property is present",
                expression: "property"
            )
                .HasSetter {
                Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, fieldName)
                continue
            }
            if !seenFieldNames.Add(fieldName) {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName)
                continue
            }
            if orderedInitializers != nil {
                if !callsPrimary && !structSymbol!!.IsClass && structSymbol!!.PrimaryConstructorParameters.Any(
                    (parameter ParameterSymbol) -> parameter.Name == fieldName
                ) {
                    inits.Add(
                        if hasField {
                            BoundFieldInitializer(
                                Invariant.Required(field, "a primary input targets its field", expression: "field"),
                                BindExpression(initSyntax.Value, memberType)
                            )
                        } else {
                            BoundFieldInitializer(
                                Invariant.Required(
                                    property,
                                    "a primary input targets its property",
                                    expression: "property"
                                ),
                                BindExpression(initSyntax.Value, memberType)
                            )
                        }
                    )
                    continue
                }
                orderedInitializers.Add(
                    StructLiteralOrderedStep.ForMember(
                        initSyntax,
                        inputType,
                        braced: nil,
                        field,
                        fieldDeclaringType,
                        property
                    )
                )
                continue
            }
            // Issue #3521: member type must reach target-dependent initializer
            // forms before they bind, not only their later conversion.
            let valueExpr = BindExpression(initSyntax.Value, inputType)
            inits.Add(
                if hasField {
                    BoundFieldInitializer(
                        Invariant.Required(field, "a resolved field has an initializer", expression: "field"),
                        valueExpr,
                        if object.ReferenceEquals(fieldDeclaringType, structSymbol) {
                            default(StructSymbol?)
                        } else {
                            fieldDeclaringType
                        }
                    )
                } else {
                    BoundFieldInitializer(
                        Invariant.Required(property, "a resolved property has an initializer", expression: "property"),
                        valueExpr
                    )
                }
            )
        }
        // Issue #948: a value-type (struct / data struct) composite literal
        // zero-initializes the storage and then assigns the listed fields. For
        // a value type there is no constructor that could run inline field
        // initializers, so apply each declared `= expr` initializer here for any
        // field the literal omitted. Positional data literals instead let
        // their primary constructor own these initializers before rewriting.
        // (For class/data-class literals the
        // synthesized default constructor — invoked by `newobj` — already runs
        // the instance field initializers, so this only applies to value types.)
        if !structSymbol!!.IsClass && !callsPrimary && !callsDataConstructor {
            for field in structSymbol!!.Fields {
                if seenFieldNames.Contains(field.Name) {
                    // A later explicit write must not leave an earlier Add
                    // observing a raw null. Seed only mandatory zero values,
                    // not a skipped, possibly effectful field initializer.
                    if hasContentElement &&
                        !(structSymbol!!.Definition ?? structSymbol)!!
                        .NeedsSynthesizedValueStructDefaultCtor {
                        let zeroValue BoundExpression? = GetStructFieldZeroValue(syntax, structSymbol!!, field)
                        if zeroValue != nil {
                            inits.Add(BoundFieldInitializer(field, zeroValue))
                        }
                    }
                    continue
                }
                if structSymbol!!.InstanceFieldInitializers.TryGetValue(field, out var initExpr) {
                    inits.Add(BoundFieldInitializer(field, initExpr){IsDeclarationInitializer = true})
                    seenFieldNames.Add(field.Name)
                }
            }
        }
        var argumentStatements ImmutableArray[BoundStatement].Builder? = nil
        let stagedMemberNames = HashSet[string](StringComparer.Ordinal)
        if orderedInitializers == nil && callsPrimary {
            inits = BoundStructLiteralExpression.PreparePrimaryArguments(syntax, structSymbol!!, inits.ToImmutable())
                .ToBuilder()
            for var i = 0; i < inits.Count; i++ {
                let initializer = inits[i]
                if callsDataConstructor && BoundStructLiteralExpression.GetPrimaryMember(
                    structSymbol!!,
                    initializer.MemberName
                ) == nil {
                    continue
                }
                argumentStatements ??= ImmutableArray.CreateBuilder[BoundStatement]()
                let argumentName = "$$literalarg" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
                    CultureInfo.InvariantCulture
                )
                let argument = LocalVariableSymbol(argumentName, isReadOnly: true, initializer.Value.Type)
                $scope.TryDeclareVariable(argument)
                argumentStatements!!.Add(BoundVariableDeclaration(nil, argument, initializer.Value))
                let value = BoundVariableExpression(nil, argument)
                inits[i] = if initializer.Field != nil {
                    BoundFieldInitializer(initializer.Field, value, initializer.FieldDeclaringType)
                } else {
                    BoundFieldInitializer(
                        Invariant.Required(
                            initializer.Property,
                            "a positional initializer targets a field or property",
                            expression: "initializer.Property"
                        ),
                        value
                    )
                }
            }
        }
        if orderedInitializers != nil && callsPrimary {
            var scalarPrefix = true
            for step in orderedInitializers {
                if step.Content != nil || step.Braced != nil {
                    scalarPrefix = false
                    continue
                }
                if step.MemberSyntax is not{} member {
                    continue
                }
                if callsDataConstructor && BoundStructLiteralExpression.GetPrimaryMember(
                    structSymbol!!,
                    member.FieldIdentifier.ValueText
                ) == nil {
                    continue
                }
                if !scalarPrefix {
                    let primaryMember Symbol? = BoundStructLiteralExpression.GetPrimaryMember(
                        structSymbol!!,
                        member.FieldIdentifier.ValueText
                    )
                    if primaryMember == nil || (step.Field != primaryMember && step.Property != primaryMember) {
                        continue
                    }
                    Diagnostics.ReportPositionalInitializerAfterCompositeElement(
                        member.FieldIdentifier.Location,
                        member.FieldIdentifier.ValueText
                    )
                    continue
                }
                let expression = BindExpression(
                    member.Value,
                    Invariant.Required(step.MemberType, "a positional member has a type", expression: "step.MemberType")
                )
                let name = "$$literalarg" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
                    CultureInfo.InvariantCulture
                )
                let argument = LocalVariableSymbol(name, isReadOnly: true, expression.Type)
                $scope.TryDeclareVariable(argument)
                argumentStatements ??= ImmutableArray.CreateBuilder[BoundStatement]()
                argumentStatements!!.Add(BoundVariableDeclaration(nil, argument, expression))
                let value = BoundVariableExpression(nil, argument)
                inits.Add(
                    if step.Field != nil {
                        BoundFieldInitializer(step.Field, value, step.FieldDeclaringType)
                    } else {
                        BoundFieldInitializer(
                            Invariant.Required(
                                step.Property,
                                "a positional member is a field or property",
                                expression: "step.Property"
                            ),
                            value
                        )
                    }
                )
                stagedMemberNames.Add(member.FieldIdentifier.ValueText)
            }
        }
        let structLiteral = BoundStructLiteralExpression(syntax, structSymbol!!, inits.ToImmutable())
        if orderedInitializers == nil {
            return if argumentStatements == nil {
                cast[BoundExpression](structLiteral)
            } else {
                cast[BoundExpression](BoundBlockExpression(nil, argumentStatements.ToImmutable(), structLiteral))
            }
        }
        // A braced member, or an ADR-0180 content element/spread, forces
        // statement lowering for every explicit initializer so scalar
        // assignments and Add(...) calls stay interleaved in lexical
        // (source) order after the primary inputs construct the receiver.
        let litTempName = "$$implit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        // ADR-0180: a content spread lowers through BindCollectionSpreadStatements,
        // which reassigns the receiver local (its Add may return an updated
        // value, e.g. for a value-type collection) — so the local can no
        // longer be readonly once any content element/spread is present.
        // Plain member-only literals (the pre-ADR-0180 shape) keep the
        // original readonly local unchanged.
        let litTemp = LocalVariableSymbol(litTempName, isReadOnly: !hasContentElement, structSymbol!!)
        $scope.TryDeclareVariable(litTemp)
        let bracedStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        if argumentStatements != nil {
            bracedStatements.AddRange(argumentStatements)
        }
        bracedStatements.Add(BoundVariableDeclaration(syntax, litTemp, structLiteral))
        for initializer in orderedInitializers {
            if initializer.Content != nil {
                let content = initializer.Content
                if content.Expression is SpreadElementExpressionSyntax spread {
                    bracedStatements.AddRange(BindCollectionSpreadStatements(litTemp, spread))
                } else {
                    let addCall = BindCollectionAddCall(litTemp, content, ImmutableArray.Create(content.Expression))
                    bracedStatements.Add(BoundExpressionStatement(content, addCall))
                }
                continue
            }
            let memberSyntax = Invariant.Required(
                initializer.MemberSyntax,
                "a member step has member syntax",
                expression: "initializer.MemberSyntax"
            )
            let memberType = Invariant.Required(
                initializer.MemberType,
                "a member step has a member type",
                expression: "initializer.MemberType"
            )
            if stagedMemberNames.Contains(memberSyntax.FieldIdentifier.ValueText) {
                continue
            }
            if initializer.Braced != nil {
                let litReceiver = BoundVariableExpression(memberSyntax, litTemp)
                if !TryEmitMemberCollectionInitializer(
                    litReceiver,
                    memberSyntax.FieldIdentifier.ValueText,
                    memberSyntax.FieldIdentifier,
                    initializer.Braced!!,
                    bracedStatements
                ) {
                    Diagnostics.ReportTypeNotCollectionInitializable(memberSyntax.FieldIdentifier.Location, memberType)
                    BindCollectionElementsForDiagnostics(initializer.Braced!!)
                }
                continue
            }
            let converted = BindExpression(memberSyntax.Value, memberType)
            let assignment BoundExpression = if initializer.Field != nil {
                cast[BoundExpression](
                    BoundFieldAssignmentExpression(
                        memberSyntax,
                        litTemp,
                        Invariant.Required(
                            initializer.FieldDeclaringType,
                            "a resolved field has a declaring type",
                            expression: "initializer.FieldDeclaringType"
                        ),
                        initializer.Field,
                        converted
                    )
                )
            } else {
                cast[BoundExpression](
                    BoundPropertyAssignmentExpression(
                        memberSyntax,
                        BoundVariableExpression(memberSyntax, litTemp),
                        structSymbol,
                        Invariant.Required(
                            initializer.Property,
                            "a resolved property initializer has a property",
                            expression: "initializer.Property"
                        ),
                        converted
                    )
                )
            }
            bracedStatements.Add(BoundExpressionStatement(memberSyntax, assignment))
        }
        let litResult = BoundVariableExpression(syntax, litTemp)
        return BoundBlockExpression(syntax, bracedStatements.ToImmutable(), litResult)
    }

    private func BindStructuralSpreadLiteral(
        syntax StructLiteralExpressionSyntax,
        resolvedDefinition StructSymbol?,
        enclosingTypeArguments ImmutableArray[TypeSymbol],
        resolvedTarget TypeSymbol? = nil
    ) BoundExpression {
        let emptyTargetSyntax = StructLiteralExpressionSyntax(
            syntax.SyntaxTree,
            syntax.TypeIdentifier,
            syntax.OpenBraceToken,
            spreadToken: nil,
            spreadExpression: nil,
            spreadSeparatorToken: nil,
            GSharp
                .Core
                .CodeAnalysis
                .Syntax
                .SeparatedSyntaxList[StructLiteralElementSyntax](ImmutableArray[SyntaxNode].Empty),
            syntax.CloseBraceToken
        ){TypeArgumentList = syntax.TypeArgumentList}
        let boundTarget = if resolvedTarget != nil {
            cast[BoundExpression](BoundDefaultExpression(emptyTargetSyntax, resolvedTarget))
        } else {
            BindStructLiteralExpression(
                emptyTargetSyntax,
                resolvedDefinition,
                enclosingTypeArguments,
                resolveTypeOnly: true
            )
        }
        let spreadExpression = Invariant.Required(
            syntax.SpreadExpression,
            "a structural spread has a source expression",
            expression: "syntax.SpreadExpression"
        )
        let source = BindExpression(spreadExpression)
        if boundTarget is BoundErrorExpression {
            for initializer in syntax.Initializers {
                let _ = BindExpression(initializer.Value)
            }
            return BoundErrorExpression(syntax)
        }
        let explicitNames = HashSet[string](StringComparer.Ordinal)
        for initializer in syntax.Initializers {
            explicitNames.Add(initializer.FieldIdentifier.ValueText)
        }
        if !StructuralProjectionPlanner.TryCreate(
            source.Type,
            boundTarget.Type,
            strict: false,
            explicitNames,
            out var plan,
            out _
        ) ||
            plan is not{} resolvedPlan {
            let failedValues = Dictionary[string, BoundExpression](StringComparer.Ordinal)
            let failedOrder = ImmutableArray.CreateBuilder[string](syntax.Initializers.Count)
            for initializer in syntax.Initializers {
                failedValues[initializer.FieldIdentifier.ValueText] = BindExpression(initializer.Value)
                failedOrder.Add(initializer.FieldIdentifier.ValueText)
            }
            return conversions.BindStructuralProjection(
                spreadExpression.Location,
                source,
                boundTarget.Type,
                strict: false,
                explicitValues: failedValues,
                explicitOrder: failedOrder.ToImmutable(),
                constructionSyntax: syntax
            )
        }
        plan = resolvedPlan
        let slotTypes = Dictionary[string, TypeSymbol](StringComparer.Ordinal)
        for slot in plan.ConstructorSlots.Concat(plan.InitializerSlots) {
            slotTypes[slot.Name] = slot.TargetType
        }
        let values = Dictionary[string, BoundExpression](StringComparer.Ordinal)
        let order = ImmutableArray.CreateBuilder[string](syntax.Initializers.Count)
        for initializer in syntax.Initializers {
            let name = initializer.FieldIdentifier.ValueText
            if values.ContainsKey(name) {
                Diagnostics.ReportSymbolAlreadyDeclared(initializer.FieldIdentifier.Location, name)
                let _ = BindExpression(initializer.Value)
                continue
            }
            if !slotTypes.TryGetValue(name, out var slotType) {
                let _ = BindExpression(initializer.Value)
                Diagnostics.ReportStructuralProjectionFailure(
                    initializer.FieldIdentifier.Location,
                    source.Type,
                    boundTarget.Type,
                    "Explicit initializer '$name' does not name a public construction or writable member slot."
                )
                continue
            }
            if initializer.Value is CollectionInitializerExpressionSyntax{Target: nil} collection {
                BindCollectionElementsForDiagnostics(collection)
                Diagnostics.ReportStructuralProjectionFailure(
                    initializer.FieldIdentifier.Location,
                    source.Type,
                    boundTarget.Type,
                    "Explicit projection initializer '$name' requires an expression value."
                )
                continue
            }
            values.Add(name, BindExpression(initializer.Value, slotType))
            order.Add(name)
        }
        return conversions.BindStructuralProjection(
            spreadExpression.Location,
            source,
            boundTarget.Type,
            strict: false,
            explicitValues: values,
            explicitOrder: order.ToImmutable(),
            constructionSyntax: syntax
        )
    }

    // ADR-0180: bare content elements and content spreads lower through
    // BindImportedTypeObjectInitializer below, shared by both the
    // reference-type and value-type imported literal binders — see that
    // function for the Add(...) lowering and the GS0369 gate.
    /// Issue #2258: dispatches a composite literal `T{Member: value, ...}`
    /// on an imported CLR type (resolved either by simple name through the
    /// import table, or by a fully-qualified namespace path via
    /// (cref:TryBindQualifiedClrStructLiteral)) to the reference-type or
    /// value-type binder, mirroring the C# object-initializer contract for
    /// either kind.
    private func BindImportedTypeLiteralExpression(
        syntax StructLiteralExpressionSyntax,
        clrType Type,
        resultTypeOverride TypeSymbol? = nil,
        resolveTypeOnly bool = false
    ) BoundExpression -> if resolveTypeOnly {
        BoundDefaultExpression(
            syntax,
            resultTypeOverride ?? TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.TypeStructure)
        )
    } else if syntax.SpreadExpression != nil {
        BindStructuralSpreadLiteral(
            syntax,
            resolvedDefinition: nil,
            enclosingTypeArguments: default(ImmutableArray[TypeSymbol]),
            resolvedTarget: resultTypeOverride ??
                (
                if ImportedTypeSymbol.TryCreateSemanticAggregate(clrType, $scope.References, out var aggregate) {
                    cast[TypeSymbol](aggregate!!)
                } else {
                    TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.TypeStructure)
                }
            )
        )
    } else if clrType.IsValueType {
        BindImportedValueTypeLiteralExpression(syntax, clrType, resultTypeOverride)
    } else {
        BindImportedClassLiteralExpression(syntax, clrType, resultTypeOverride)
    }

    private func BindImportedDataClassLiteral(
        syntax StructLiteralExpressionSyntax,
        clrType Type,
        resultType ImportedTypeSymbol,
        aggregate StructSymbol
    ) BoundExpression {
        if clrType.IsAbstract {
            Diagnostics.ReportCannotInstantiateAbstractType(syntax.TypeIdentifier.Location, aggregate.Name)
            return BoundErrorExpression(syntax)
        }
        if !aggregate.HasPrimaryConstructor {
            return BindImportedClassLiteralExpression(syntax, clrType, resultType)
        }
        let constructor = ImportedTypeSymbol.FindPrimaryConstructor(clrType, aggregate.PrimaryConstructorParameters)
        if constructor == nil {
            Diagnostics.ReportNoApplicableOverload(syntax.TypeIdentifier.Location, aggregate.Name)
            return BoundErrorExpression(syntax)
        }
        let parameters = constructor.GetParameters()
        let arguments = [parameters.Length]BoundExpression
        let consumed = HashSet[string](StringComparer.Ordinal)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        var primaryPrefix = true
        for element in syntax.Elements {
            if element is not FieldInitializerSyntax initializer {
                primaryPrefix = false
                continue
            }
            let index = Array.FindIndex(
                parameters,
                (parameter ParameterInfo) -> parameter.Name == initializer.FieldIdentifier.ValueText
            )
            if index < 0 || initializer.Value is CollectionInitializerExpressionSyntax{Target: nil} {
                primaryPrefix = false
                continue
            }
            if !consumed.Add(initializer.FieldIdentifier.ValueText) {
                continue
            }
            if !primaryPrefix {
                Diagnostics.ReportPositionalInitializerAfterCompositeElement(
                    initializer.FieldIdentifier.Location,
                    initializer.FieldIdentifier.ValueText
                )
            }
            // Read the constructor input, not its associated property's erased CLR type.
            let parameterType = MemberLookup.GetClrMethodParameterTypeSymbol(resultType, constructor, index)
            let value = BindExpression(initializer.Value, parameterType)
            let name = "$$literalarg" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
                CultureInfo.InvariantCulture
            )
            let local = LocalVariableSymbol(name, isReadOnly: true, parameterType)
            $scope.TryDeclareVariable(local)
            statements.Add(BoundVariableDeclaration(initializer, local, value))
            arguments[index] = BoundVariableExpression(initializer, local)
        }
        for var index = 0; index < arguments.Length; index++ {
            if arguments[index] == nil {
                let parameterType = MemberLookup.GetClrMethodParameterTypeSymbol(resultType, constructor, index)
                arguments[index] = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(syntax, parameterType) ??
                    BoundDefaultExpression(syntax, parameterType)
            }
        }
        let construction = BoundClrConstructorCallExpression(
            syntax,
            clrType,
            constructor,
            arguments.ToImmutableArray(),
            resultType
        )
        let initialized = BindImportedTypeObjectInitializer(syntax, clrType, resultType, construction, consumed)
        if initialized is BoundBlockExpression initializerBlock {
            statements.AddRange(initializerBlock.Statements)
            return BoundBlockExpression(syntax, statements.ToImmutable(), initializerBlock.Expression)
        }
        return BoundBlockExpression(syntax, statements.ToImmutable(), initialized)
    }

    /// ADR-0180: binds (for diagnostic continuity) and reports GS0369 for
    /// every content element/spread found directly on [`syntax`](paramref),
    /// for the struct-literal binder paths that do not (yet) support them —
    /// type-parameter construction ((cref:BindTypeParameterObjectInitializer)).
    /// That path only ever reads (cref:StructLiteralExpressionSyntax.Initializers)
    /// (members), so without this guard a content element would be silently
    /// skipped rather than diagnosed. Imported-CLR-type construction does not
    /// use this guard — (cref:BindImportedTypeObjectInitializer) lowers
    /// content elements directly.
    private func ReportUnsupportedStructLiteralContentElements(
        syntax StructLiteralExpressionSyntax,
        resultType TypeSymbol
    ) bool {
        var hasContentElement = false
        for element in syntax.Elements {
            if element is not StructLiteralContentElementSyntax contentElement {
                continue
            }
            hasContentElement = true
            let _ = BindExpression(
                if contentElement.Expression is SpreadElementExpressionSyntax spread {
                    spread.Expression
                } else {
                    contentElement.Expression
                }
            )
        }
        if hasContentElement {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, resultType)
        }
        return hasContentElement
    }

    /// Issue #1199: binds a composite literal `T{Member: value, ...}` on an
    /// IMPORTED reference-type class (e.g. `JsonSerializerOptions{WriteIndented:
    /// true}`). It lowers to the same shape as the object-initializer suffix
    /// (`T(){ Member = value }`, ADR-0117 / issue #569): construct the
    /// instance via its public parameterless constructor into a synthetic local,
    /// assign each named settable property/field through that local, and yield
    /// the local. Reusing existing bound nodes ((cref:BoundClrConstructorCallExpression),
    /// (cref:BoundClrPropertyAssignmentExpression)) means emit and the
    /// interpreter both work without a new bound-node kind.
    private func BindImportedClassLiteralExpression(
        syntax StructLiteralExpressionSyntax,
        clrType Type,
        resultTypeOverride TypeSymbol? = nil
    ) BoundExpression {
        // The object-initializer lowering needs a constructed instance; require a
        // public parameterless constructor (the C# object-initializer contract).
        let parameterlessCtor ConstructorInfo? = FindPublicParameterlessConstructor(clrType)
        if parameterlessCtor == nil {
            Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, syntax.TypeIdentifier.ValueText)
            for badElement in syntax.Elements {
                if badElement is StructLiteralContentElementSyntax badContent {
                    let _ = BindExpression(
                        if badContent.Expression is SpreadElementExpressionSyntax badSpread {
                            badSpread.Expression
                        } else {
                            badContent.Expression
                        }
                    )
                } else if badElement is FieldInitializerSyntax badField {
                    let _ = BindExpression(badField.Value)
                }
            }
            return BoundErrorExpression(nil)
        }
        let resultType = resultTypeOverride ?? TypeSymbol.FromClrTypeWithoutNullability(
            clrType,
            NullabilityFreeReason.TypeStructure
        )
        let construction BoundExpression = BoundClrConstructorCallExpression(
            syntax,
            clrType,
            parameterlessCtor,
            ImmutableArray[BoundExpression].Empty,
            resultType
        )
        return BindImportedTypeObjectInitializer(syntax, clrType, resultType, construction)
    }

    /// Issue #2258: binds a composite literal `T{Member: value, ...}` on an
    /// IMPORTED VALUE-TYPE struct (e.g.
    /// `System.Text.Json.JsonWriterOptions{ Indented: true }`). Unlike a
    /// reference type, reflection never synthesizes a public parameterless
    /// constructor for a plain value type (one only appears when the type
    /// explicitly declares a C# 10+ parameterless struct constructor), so the
    /// instance is seeded with its default/zero value (mirroring IL
    /// `initobj`) when no explicit parameterless constructor is found. The
    /// remaining member-assignment lowering is shared with the reference-type
    /// path; the value-type receiver is written in place through its local slot
    /// (see `EmitClrPropertyAssignment`'s addressable-receiver handling), so
    /// no copy-back step is needed.
    private func BindImportedValueTypeLiteralExpression(
        syntax StructLiteralExpressionSyntax,
        clrType Type,
        resultTypeOverride TypeSymbol? = nil
    ) BoundExpression {
        let resultType = resultTypeOverride ?? TypeSymbol.FromClrTypeWithoutNullability(
            clrType,
            NullabilityFreeReason.TypeStructure
        )
        var constructor ConstructorInfo? = FindPublicParameterlessConstructor(clrType)
        let arguments = ImmutableArray.CreateBuilder[BoundExpression]()
        let argumentStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        let constructorMembers = HashSet[string](StringComparer.Ordinal)
        if ImportedTypeSymbol.TryCreateSemanticAggregate(clrType, binderCtx.References, out var aggregate) &&
            aggregate!!
            .UsesConstructorOwnedDataConstruction {
            if !BoundStructLiteralExpression.ValidateDataConstructor(
                aggregate!!,
                Diagnostics,
                syntax,
                getCurrentFunction(),
                binderCtx.References.CanAccessInternalMembers(clrType.Assembly)
            ) {
                return BoundErrorExpression(syntax)
            }
            constructor = aggregate!!.GetDataConstructionConstructor()
            let supplied = Dictionary[string, BoundExpression](StringComparer.Ordinal)
            let parameters = if aggregate!!.HasDataConstructionPrimary {
                aggregate!!.PrimaryConstructorParameters
            } else {
                ImmutableArray[ParameterSymbol].Empty
            }
            for parameter in parameters {
                constructorMembers.Add(parameter.Name)
            }
            var beforePopulation = true
            for element in syntax.Elements {
                if element is not FieldInitializerSyntax member ||
                    member.Value is CollectionInitializerExpressionSyntax{Target: nil} {
                    beforePopulation = false
                    continue
                }
                let name = member.FieldIdentifier.ValueText
                if !constructorMembers.Contains(name) {
                    continue
                }
                if !beforePopulation {
                    Diagnostics.ReportPositionalInitializerAfterCompositeElement(member.FieldIdentifier.Location, name)
                }
                if supplied.ContainsKey(name) {
                    Diagnostics.ReportSymbolAlreadyDeclared(member.FieldIdentifier.Location, name)
                    continue
                }
                let index = parameters.IndexOf(parameters.First((parameter ParameterSymbol) -> parameter.Name == name))
                let type = MemberLookup.GetClrMethodParameterTypeSymbol(resultType, constructor!!, index)
                let value = BindExpression(member.Value, type)
                let temporary = LocalVariableSymbol(
                    "$$literalarg" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
                        CultureInfo.InvariantCulture
                    ),
                    isReadOnly: true,
                    type
                )
                argumentStatements.Add(BoundVariableDeclaration(member, temporary, value))
                supplied.Add(name, BoundVariableExpression(member, temporary))
            }
            for var i = 0; i < parameters.Length; i++ {
                let type = MemberLookup.GetClrMethodParameterTypeSymbol(resultType, constructor!!, i)
                arguments.Add(
                    if supplied.TryGetValue(parameters[i].Name, out var value) {
                        value
                    } else {
                        MagicCollectionZeroValue.TrySynthesizePrimaryArgument(
                            syntax,
                            aggregate!!,
                            parameters[i],
                            type
                        ) ??
                            BoundDefaultExpression(syntax, type)
                    }
                )
            }
        }
        let construction BoundExpression = if constructor != nil {
            cast[BoundExpression](
                BoundClrConstructorCallExpression(syntax, clrType, constructor, arguments.ToImmutable(), resultType)
            )
        } else {
            cast[BoundExpression](BoundDefaultExpression(syntax, resultType))
        }
        let initialized = BindImportedTypeObjectInitializer(
            syntax,
            clrType,
            resultType,
            construction,
            constructorMembers
        )
        return if argumentStatements.Count == 0 {
            initialized
        } else {
            BoundBlockExpression(syntax, argumentStatements.ToImmutable(), initialized)
        }
    }

    /// Issue #1199 / #2258: shared object-initializer lowering for an imported
    /// CLR type composite literal — assigns each named settable property/field
    /// through a synthetic local seeded with [`construction`](paramref)
    /// (a constructor call or a default-value expression), and yields the
    /// local. Shared by the reference-type and value-type literal binders.
    private func BindImportedTypeObjectInitializer(
        syntax StructLiteralExpressionSyntax,
        clrType Type,
        resultType TypeSymbol,
        construction BoundExpression,
        constructorMembers ISet[string]? = nil
    ) BoundExpression {
        // ADR-0180: a bare content element or `...source` content spread on an
        // imported CLR type (e.g. `List[int32]{ Capacity: 1, 2 }`) lowers to
        // Add(...) through the same accessor-call binder as the primary
        // struct-literal path — reusing HasCollectionAdd/HasUnaryCollectionAdd
        // and reporting the same GS0369 on failure. Imported targets are not
        // excluded from ADR-0180's scope.
        var hasBareContentElement = false
        var hasSpreadContentElement = false
        for scanElement in syntax.Elements {
            if scanElement is not StructLiteralContentElementSyntax scanContent {
                continue
            }
            if scanContent.Expression is SpreadElementExpressionSyntax {
                hasSpreadContentElement = true
            } else {
                hasBareContentElement = true
            }
        }
        let hasContentElement = hasBareContentElement || hasSpreadContentElement
        if (hasBareContentElement && !HasCollectionAdd(resultType)) ||
            (hasSpreadContentElement && !HasUnaryCollectionAdd(resultType)) {
            Diagnostics.ReportTypeNotCollectionInitializable(syntax.OpenBraceToken.Location, resultType)
            for badElement in syntax.Elements {
                if badElement is StructLiteralContentElementSyntax badContent {
                    let _ = BindExpression(
                        if badContent.Expression is SpreadElementExpressionSyntax badSpread {
                            badSpread.Expression
                        } else {
                            badContent.Expression
                        }
                    )
                } else if badElement is FieldInitializerSyntax badField {
                    let _ = BindExpression(badField.Value)
                }
            }
            return BoundErrorExpression(nil)
        }
        let tempName = "$$implit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        // ADR-0180: a content spread's lowering reassigns the receiver local
        // (BindCollectionSpreadStatements), so it can no longer be readonly
        // once any content element/spread is present — mirroring the primary
        // struct-literal path.
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: !hasContentElement, resultType)
        $scope.TryDeclareVariable(tempVar)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, tempVar, construction))
        // Only raw default construction needs reconstruction. A real
        // constructor has already established its own field values.
        let zeroValueStatements = ImmutableArray.CreateBuilder[BoundStatement]()
        if construction is BoundDefaultExpression && clrType.IsValueType {
            let excludedMembers = if hasContentElement {
                default(HashSet[string]?)
            } else {
                syntax
                    .Initializers
                    .Select((member FieldInitializerSyntax) -> member.FieldIdentifier.ValueText)
                    .ToHashSet(StringComparer.Ordinal)
            }
            AppendImportedStructZeroInitializers(syntax, clrType, tempVar, excludedMembers, zeroValueStatements)
        }
        if hasContentElement {
            statements.AddRange(zeroValueStatements)
        }
        let seen = HashSet[string]()
        for element in syntax.Elements {
            if element is StructLiteralContentElementSyntax contentElement {
                if contentElement.Expression is SpreadElementExpressionSyntax spread {
                    statements.AddRange(BindCollectionSpreadStatements(tempVar, spread))
                } else {
                    let addCall = BindCollectionAddCall(
                        tempVar,
                        contentElement,
                        ImmutableArray.Create(contentElement.Expression)
                    )
                    statements.Add(BoundExpressionStatement(contentElement, addCall))
                }
                continue
            }
            let initSyntax = cast[FieldInitializerSyntax](element)
            let memberName = initSyntax.FieldIdentifier.ValueText
            if constructorMembers?.Contains(memberName) == true &&
                initSyntax.Value is not CollectionInitializerExpressionSyntax{Target: nil} {
                seen.Add(memberName)
                continue
            }
            if !seen.Add(memberName) {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName)
                continue
            }
            if constructorMembers?.Contains(memberName) == true {
                continue
            }
            // Resolve a public instance property (non-indexer) or field on the
            // imported CLR type. A settable member binds to a CLR property/field
            // assignment; a get-only/read-only member stays diagnosed (GS0127).
            //
            // A friend assembly (one that named this compilation in an
            // `InternalsVisibleTo`) also exposes its `internal` properties and
            // fields. The probes are the ones plain `x.Member = v` uses
            // (#3705): public first, then a friend's `assembly` members only,
            // with the #3704 own-field ordering, so the two paths cannot
            // disagree.
            var member MemberInfo? = SafeGetVisibleInstanceProperty(clrType, memberName)
            if member is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0 {
                member = nil
            }
            member ??= SafeGetVisibleInstanceField(clrType, memberName)
            if member == nil {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName)
                let _ = BindExpression(initSyntax.Value)
                continue
            }
            // Issue #1567: a braced member value `Member: { a, b }` populates the
            // (typically get-only) collection member by lowering to `.Add(...)`
            // calls on `receiver.Member` — the C# collection-initializer-in-
            // object-initializer pattern. This applies whether or not the member
            // is assignable (C# always uses Add semantics for the `= { … }`
            // form), so it is handled before the writability check.
            if initSyntax.Value is CollectionInitializerExpressionSyntax{Target: nil} bracedInit {
                let bracedReceiver = BoundVariableExpression(initSyntax, tempVar)
                if !TryEmitMemberCollectionInitializer(
                    bracedReceiver,
                    memberName,
                    initSyntax.FieldIdentifier,
                    bracedInit,
                    statements
                ) {
                    Diagnostics.ReportTypeNotCollectionInitializable(
                        initSyntax.FieldIdentifier.Location,
                        MemberLookup.GetClrMemberValueTypeSymbol(member).StripToBareShape()
                    )
                    BindCollectionElementsForDiagnostics(bracedInit)
                }
                continue
            }
            if !TryGetWritableClrMember(member, tempVar.Type, out _, out var targetSymbol, out _) {
                Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName)
                let _ = BindExpression(initSyntax.Value)
                continue
            }
            let converted = BindExpression(initSyntax.Value, targetSymbol!!)
            let receiverExpr = BoundVariableExpression(initSyntax, tempVar)
            statements.Add(
                BoundExpressionStatement(
                    initSyntax,
                    BoundClrPropertyAssignmentExpression(
                        initSyntax,
                        receiverExpr,
                        member,
                        converted,
                        targetSymbol!!,
                        staticContainerType: nil
                    )
                )
            )
        }
        // Keep the historical omitted-field ordering for members-only literals.
        if !hasContentElement {
            statements.AddRange(zeroValueStatements)
        }
        let resultExpr = BoundVariableExpression(syntax, tempVar)
        return BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr)
    }

    private func AppendImportedStructZeroInitializers(
        syntax SyntaxNode,
        clrType Type,
        receiver LocalVariableSymbol,
        excludedMembers HashSet[string]?,
        statements ImmutableArray[BoundStatement].Builder
    ) {
        if !ImportedAssemblySemantics.TryGetMagicCollectionFields(clrType, out var magicFieldKinds) {
            return
        }
        for (fieldName, kind) in magicFieldKinds {
            if excludedMembers?.Contains(fieldName) == true {
                continue
            }
            let field FieldInfo? = clrType.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance)
            let zeroValue BoundExpression? = if field != nil {
                MagicCollectionZeroValue.TrySynthesizeEmptyInstanceFromMarker(
                    field,
                    kind,
                    MemberLookup.GetClrFieldTypeSymbol(receiver.Type, field)
                )
            } else {
                nil
            }
            if field == nil ||
                zeroValue == nil ||
                !TryGetWritableClrMember(field, receiver.Type, out _, out var fieldType, out var writable) ||
                !writable {
                continue
            }
            let converted = conversions.BindConversion(syntax.Location, zeroValue, fieldType)
            statements.Add(
                BoundExpressionStatement(
                    syntax,
                    BoundClrPropertyAssignmentExpression(
                        syntax,
                        BoundVariableExpression(syntax, receiver),
                        field,
                        converted,
                        fieldType!!,
                        staticContainerType: nil
                    )
                )
            )
        }
    }

    /// Issue #988 / #1235: binds a composite literal `T{Member: value, ...}`
    /// on a type parameter [`tp`](paramref) constrained `where T : class,
    /// new()` (or `init()` in the G# spelling) — the generic-method
    /// counterpart of C#'s `new T { Member = value }`. Constructs `T`
    /// via the same reified (cref:BoundTypeParameterConstructionExpression)
    /// that a bare `T()` call produces, then assigns each named member
    /// through the constraint's field/property surface (class constraint fields
    /// and properties, or a non-generic interface constraint's settable
    /// properties) — mirroring the assignment-side member resolution in
    /// (cref:BindFieldAssignmentExpression)'s type-parameter branch. Shared
    /// by both binders so a variable receiver (`t.Member = v`) and an
    /// object-initializer literal (`T{Member: v}`) resolve members
    /// identically.
    private func BindTypeParameterObjectInitializer(
        syntax StructLiteralExpressionSyntax,
        tp TypeParameterSymbol
    ) BoundExpression {
        // ADR-0180: see ReportUnsupportedStructLiteralContentElements — a
        // type-parameter construction (`T{Field: value}` under a `new()`
        // constraint) never learned Add(...) lowering either.
        if ReportUnsupportedStructLiteralContentElements(syntax, tp) {
            return BoundErrorExpression(nil)
        }
        let tempName = "$$implit" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let tempVar = LocalVariableSymbol(tempName, isReadOnly: true, tp)
        $scope.TryDeclareVariable(tempVar)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, tempVar, BoundTypeParameterConstructionExpression(syntax, tp)))
        let seen = HashSet[string]()
        for initSyntax in syntax.Initializers {
            let memberName = initSyntax.FieldIdentifier.ValueText
            if !seen.Add(memberName) {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName)
                let _ = BindExpression(initSyntax.Value)
                continue
            }
            let receiverExpr = BoundVariableExpression(initSyntax, tempVar)
            if tp.ClassConstraint is StructSymbol classConstraint {
                if TypeMemberModel.TryGetFieldIncludingInherited(
                    classConstraint,
                    memberName,
                    MemberQuery.Instance(MemberKinds.Field),
                    out var field,
                    out var fieldDeclaringType
                ) {
                    let fieldConverted = BindExpression(initSyntax.Value, field.Type)
                    statements.Add(
                        BoundExpressionStatement(
                            initSyntax,
                            BoundFieldAssignmentExpression.WithExpressionReceiver(
                                initSyntax,
                                receiverExpr,
                                fieldDeclaringType,
                                field,
                                fieldConverted
                            )
                        )
                    )
                    continue
                }
                if TypeMemberModel.TryGetProperty(
                    classConstraint,
                    memberName,
                    out var classProp,
                    out var classPropDeclaringType
                ) {
                    if !classProp.HasSetter {
                        Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName)
                        let _ = BindExpression(initSyntax.Value)
                        continue
                    }
                    let classPropConverted = BindExpression(initSyntax.Value, classProp.Type)
                    statements.Add(
                        BoundExpressionStatement(
                            initSyntax,
                            BoundPropertyAssignmentExpression(
                                initSyntax,
                                receiverExpr,
                                classPropDeclaringType,
                                classProp,
                                classPropConverted
                            )
                        )
                    )
                    continue
                }
            }
            if tp.InterfaceConstraint is InterfaceSymbol interfaceConstraint &&
                !interfaceConstraint.IsGenericDefinition &&
                interfaceConstraint
                .TypeArguments
                .IsDefaultOrEmpty &&
                TypeMemberModel
                .TryGetProperty(interfaceConstraint, memberName, out var ifaceProp, out _) {
                if !ifaceProp!!.HasSetter {
                    Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName)
                    let _ = BindExpression(initSyntax.Value)
                    continue
                }
                let ifacePropConverted = BindExpression(initSyntax.Value, ifaceProp!!.Type)
                statements.Add(
                    BoundExpressionStatement(
                        initSyntax,
                        BoundPropertyAssignmentExpression(
                            initSyntax,
                            receiverExpr,
                            nil,
                            ifaceProp!!,
                            ifacePropConverted
                        )
                    )
                )
                continue
            }
            if tp.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint &&
                clrInterfaceConstraint.ClrType is Type clrInterface &&
                clrInterface
                .IsInterface {
                let clrProperty PropertyInfo? = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                    clrInterface,
                    memberName,
                    BindingFlags.Public | BindingFlags.Instance
                )
                if clrProperty != nil && clrProperty.GetIndexParameters().Length == 0 {
                    if clrProperty.GetSetMethod(nonPublic: false) == nil {
                        Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName)
                        let _ = BindExpression(initSyntax.Value)
                        continue
                    }
                    let propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty)
                    let declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                        clrInterfaceConstraint,
                        clrProperty
                    )
                    let converted = BindExpression(initSyntax.Value, propertyType)
                    statements.Add(
                        BoundExpressionStatement(
                            initSyntax,
                            BoundClrPropertyAssignmentExpression(
                                initSyntax,
                                receiverExpr,
                                clrProperty,
                                converted,
                                propertyType,
                                staticContainerType: nil,
                                constrainedReceiverTypeParameter: tp,
                                constrainedInterfaceType: declaringInterface
                            )
                        )
                    )
                    continue
                }
            }
            Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName)
            let _ = BindExpression(initSyntax.Value)
        }
        let resultExpr = BoundVariableExpression(syntax, tempVar)
        return BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr)
    }

    private func BindTupleLiteralExpression(syntax TupleLiteralExpressionSyntax) BoundExpression {
        // Phase 4.5: bind each element expression, derive the tuple type from
        // their static types, and produce a BoundTupleLiteralExpression.
        // ADR-0172: a `name: expr` element contributes the label to the
        // literal's tuple type; names are metadata over the positional shape.
        let bound = ImmutableArray.CreateBuilder[BoundExpression](syntax.Elements.Count)
        let elementTypes = ImmutableArray.CreateBuilder[TypeSymbol](syntax.Elements.Count)
        let elementNames = ImmutableArray.CreateBuilder[string?](syntax.Elements.Count)
        var anyName = false
        let nameTokens = [syntax.Elements.Count]SyntaxToken?
        for var i = 0; i < syntax.Elements.Count; i++ {
            var e = syntax.Elements[i]
            if e is NamedTupleElementSyntax named {
                nameTokens[i] = named.NameToken
                elementNames.Add(named.NameToken.ValueText)
                anyName = true
                e = named.Expression
            } else {
                elementNames.Add(nil)
            }
            let be = BindExpression(e)
            if be.Type == TypeSymbol.Error {
                return BoundErrorExpression(nil)
            }
            bound.Add(be)
            elementTypes.Add(be.Type)
        }
        let names = if anyName {
            elementNames.MoveToImmutable()
        } else {
            ImmutableArray[string?].Empty
        }
        if anyName {
            ValidateTupleElementNames(
                names,
                (i int32) -> Invariant.Required(
                    nameTokens[i],
                    "a named element recorded its token",
                    expression: "nameTokens[i]"
                )
                    .Location
            )
        }
        let tupleType = TupleTypeSymbol.Get(elementTypes.MoveToImmutable(), names)
        return BoundTupleLiteralExpression(nil, tupleType, bound.MoveToImmutable())
    }

    /// ADR-0172: validates declared tuple element names — duplicates
    /// (GS0540) and reserved names (GS0542: `ItemN` anywhere but
    /// position N, and `Rest`, which the CLR encoding uses for arity
    /// ≥ 8). Shared by tuple literals and tuple type clauses.
    /// @param names The declared names, `null` where unnamed.
    /// @param locationOf Maps an element index to its name token's location.
    internal func ValidateTupleElementNames(
        names ImmutableArray[string?],
        locationOf(int32) -> TextLocation
    ) -> TupleElementNameValidation.Validate(Diagnostics, names, locationOf)

    /// ADR-0039: Computes per-argument (cref:RefKind) from CLR parameter metadata.
    ///
    /// Issue #368 / ADR-0055: rewrites any interpolated-string argument passed to
    /// a parameter typed as a user-defined `[InterpolatedStringHandler]` so
    /// that it carries the resolved handler-construction target. The referenced
    /// surrounding arguments / receiver named by
    /// `[InterpolatedStringHandlerArgument]` are captured and forwarded into
    /// the handler constructor by the emit lowerer. Arguments that are not
    /// handler-targeted interpolations are returned unchanged.
    /// @param parameters The resolved method's/constructor's parameters.
    /// @param arguments The bound positional arguments (aligned with the leading parameters).
    /// @param receiver The instance receiver, or `null` for static/constructor calls.
    /// @param location The diagnostic location for the call.
    /// @param parameterMapping Issue #343: per-source-argument → parameter-position map; default for
    /// identity.
    /// @param isExpanded Whether trailing source arguments target a params-array element.
    /// @returns The arguments, with handler-targeted interpolations rewritten.
    private func ApplyInterpolatedStringHandlers(
        parameters[]ParameterInfo,
        arguments ImmutableArray[BoundExpression],
        receiver BoundExpression?,
        location TextLocation,
        parameterMapping ImmutableArray[int32] = default(ImmutableArray[int32]),
        isExpanded bool = false
    ) ImmutableArray[BoundExpression] {
        return ApplyInterpolatedStringHandlers(
            parameters,
            arguments,
            receiver,
            location,
            parameterMapping,
            isExpanded,
            out _,
            out _
        )
    }

    /// Issue #377 sub-items 1 + 2: extended overload that rewrites
    /// handler-targeted interpolations and captures a separate instance
    /// receiver exactly once (matches C# §11.18.1). Source arguments and
    /// synthesized extension receivers are captured later in lexical order.
    /// Returns receiver capture statements through
    /// [`preludeStatements`](paramref) and the substituted receiver
    /// through [`updatedReceiver`](paramref). Callers wrap the call in a
    /// (cref:BoundBlockExpression) when the prelude is non-empty.
    private func ApplyInterpolatedStringHandlers(
        parameters[]?ParameterInfo,
        arguments ImmutableArray[BoundExpression],
        receiver BoundExpression?,
        location TextLocation,
        parameterMapping ImmutableArray[int32],
        isExpanded bool,
        out preludeStatements ImmutableArray[BoundStatement],
        out updatedReceiver BoundExpression?
    ) ImmutableArray[BoundExpression] {
        preludeStatements = ImmutableArray[BoundStatement].Empty
        updatedReceiver = receiver
        if parameters == nil || arguments.IsDefaultOrEmpty {
            return arguments
        }
        var argBuilder ImmutableArray[BoundExpression].Builder? = nil
        // Pass 1: build the handler info for each interpolated-string
        // argument that targets a [InterpolatedStringHandler] parameter.
        let handlerSlots = List[
            (ArgIndex int32, Interp BoundInterpolatedStringExpression, Handler InterpolatedStringHandlerInfo)
        ]()
        for var i = 0; i < arguments.Length; i++ {
            if arguments[i] is not BoundInterpolatedStringExpression interp || interp.Handler != nil {
                continue
            }
            let paramIndex = if parameterMapping.IsDefaultOrEmpty {
                (
                    if isExpanded {
                        Math.Min(i, parameters.Length - 1)
                    } else {
                        i
                    }
                )
            } else {
                parameterMapping[i]
            }
            if paramIndex < 0 || paramIndex >= parameters.Length {
                continue
            }
            let parameter = parameters[paramIndex]
            var parameterType = parameter.ParameterType
            if isExpanded && paramIndex == parameters.Length - 1 && parameter.GetCustomAttributesData().Any(
                (attribute CustomAttributeData) -> string.Equals(
                    attribute.AttributeType.FullName,
                    "System.ParamArrayAttribute",
                    StringComparison.Ordinal
                )
            ) &&
                parameterType
                .IsArray {
                parameterType = Invariant.Required(
                    parameterType.GetElementType(),
                    "a params array has an element type",
                    expression: "parameterType.GetElementType()"
                )
            }
            // Issue #377 sub-item 1: accept a by-ref handler-typed parameter
            // (e.g. `ref DefaultInterpolatedStringHandler`). Peel before
            // testing the attribute and let InterpolatedStringHandlerInfo
            // remember the RefKind so the lowerer can feed the constructed
            // handler local by-ref/in/out.
            let peeled = if parameterType.IsByRef {
                Invariant.Required(
                    parameterType.GetElementType(),
                    "a by-ref handler parameter has an element type",
                    expression: "parameterType.GetElementType()"
                )
            } else {
                parameterType
            }
            if !InterpolatedStringHandlerInfo.IsHandlerType(peeled) {
                continue
            }
            let handler InterpolatedStringHandlerInfo? = InterpolatedStringHandlerInfo.TryCreate(
                peeled,
                parameter,
                parameters,
                arguments,
                receiver,
                parameterMapping,
                i,
                interp.Parts,
                out var failure
            )
            if handler == nil {
                Diagnostics.ReportInterpolatedStringHandlerArgument(
                    location,
                    failure ?? "unable to create the interpolated string handler"
                )
                continue
            }
            handlerSlots.Add((i, interp, handler))
        }
        if handlerSlots.Count == 0 {
            return arguments
        }
        // Pass 2 (issue #377 sub-item 2): capture a separate instance
        // receiver. Forwarded call arguments, including a synthesized
        // extension receiver, are captured later with all source arguments
        // in lexical order.
        argBuilder = arguments.ToBuilder()
        let preludeBuilder = ImmutableArray.CreateBuilder[BoundStatement]()
        var capturedReceiver = receiver
        var receiverCaptured = false
        // -1 represents a separate instance receiver.
        let captures = Dictionary[int32, BoundExpression]()
        for (_, _, handler) in handlerSlots {
            for var k = 0; k < handler.ForwardedSourceIndices.Length; k++ {
                let srcIndex = handler.ForwardedSourceIndices[k]
                if srcIndex >= 0 || receiverCaptured {
                    continue
                }
                if receiver == nil || IsSideEffectFreeForHandlerCapture(receiver) {
                    receiverCaptured = true
                    continue
                }
                let (recvLocal, recvDecl) = CreateHandlerForwardCapture(receiver, "$$handlerRecv", location)
                preludeBuilder.Add(recvDecl)
                capturedReceiver = recvLocal
                captures[-1] = recvLocal
                receiverCaptured = true
            }
        }
        // Pass 3: rewrite each handler's forwarded args + parent arg slot
        // using either the captured locals (if any) or the originals.
        for slot in handlerSlots {
            let (argIndex, interp, handler) = slot
            let rewritten = ImmutableArray.CreateBuilder[BoundExpression](handler.ForwardedArguments.Length)
            for var k = 0; k < handler.ForwardedArguments.Length; k++ {
                let srcIndex = handler.ForwardedSourceIndices[k]
                if captures.TryGetValue(srcIndex, out var captured) {
                    rewritten.Add(captured)
                } else {
                    rewritten.Add(handler.ForwardedArguments[k])
                }
            }
            let newHandler = handler.WithForwardedArguments(rewritten.ToImmutable())
            argBuilder[argIndex] = interp.Update(interp.Parts, newHandler)
        }
        updatedReceiver = capturedReceiver
        preludeStatements = preludeBuilder.ToImmutable()
        return argBuilder.ToImmutable()
    }

    /// Issue #377 sub-item 2: creates a synthetic readonly local that
    /// captures [`value`](paramref) and returns a load of that local.
    private func CreateHandlerForwardCapture(value BoundExpression, namePrefix string, location TextLocation)(
        Load BoundExpression,
        Declaration BoundStatement
    ) {
        let counter = Interlocked.Increment(&binderCtx.SyntheticLocalCounter)
        let name = namePrefix + "_" + counter.ToString(CultureInfo.InvariantCulture)
        let local = LocalVariableSymbol(name, isReadOnly: true, value.Type)
        $scope.TryDeclareVariable(local)
        let decl = BoundVariableDeclaration(value.Syntax, local, value)
        let load = BoundVariableExpression(value.Syntax, local)
        return (load, decl)
    }

    internal func BindArrayCreationExpression(syntax ArrayCreationExpressionSyntax) BoundExpression {
        var elementType TypeSymbol?
        if syntax.HasNestedElementTypeClause {
            // Issue #1046: jagged-array literal — the element is a nested type
            // clause (`[][]int32{ … }`), resolved recursively.
            elementType = bindTypeClause(
                Invariant.Required(
                    syntax.ElementTypeClause,
                    "a nested array element has a type clause",
                    expression: "syntax.ElementTypeClause"
                )
            )
            if elementType == nil {
                return BoundErrorExpression(nil)
            }
        } else {
            let elementTypeIdentifier = Invariant.Required(
                syntax.ElementTypeIdentifier,
                "a non-nested array literal has an element type identifier",
                expression: "syntax.ElementTypeIdentifier"
            )
            elementType = lookupTypeToken(elementTypeIdentifier)
            if elementType == nil {
                Diagnostics.ReportUndefinedType(elementTypeIdentifier.Location, elementTypeIdentifier.ValueText)
                return BoundErrorExpression(nil)
            }
            if elementType == TypeSymbol.Error {
                return BoundErrorExpression(nil)
            }
            // ADR-0186 §9: an array element is a nested position, so it stays
            // as written in an oblivious scope too (the owner's 2026-09-25
            // amendment to open question 12); `[]string{…}` there is a
            // `[]string`. An oblivious `[]string` slot is `[]!string` (its
            // top level only is platform), so the literal is stored there
            // through the top-level `T → T!` conversion; the element types
            // are identical.

        }
        if elementType is EnumSymbol bareElementEnum {
            elementType = CloseNestedEnumOverCurrentTypeParameters(bareElementEnum)
        }
        var hasSpreadElement = false
        if syntax.Elements != nil {
            for element in syntax.Elements {
                hasSpreadElement |= element is SpreadElementExpressionSyntax
            }
        }
        if hasSpreadElement {
            return BindSpreadArrayCreationExpression(syntax, elementType!!)
        }
        let elementSyntaxes = syntax.Elements ??
            GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty)
        let elements = ImmutableArray.CreateBuilder[BoundExpression](elementSyntaxes.Count)
        if syntax.Dimensions is {Count: > 1} dimensions {
            if dimensions.Count > 32 {
                Diagnostics.ReportRectangularArrayRankTooLarge(syntax.Location, dimensions.Count)
                return BoundErrorExpression(syntax)
            }
            let boundDimensions = ImmutableArray.CreateBuilder[BoundExpression](dimensions.Count)
            for dimension in dimensions {
                boundDimensions.Add(conversions.BindConversion(dimension, TypeSymbol.Int32))
            }
            let rectangularElements = ImmutableArray.CreateBuilder[BoundExpression](elementSyntaxes.Count)
            for elementSyntax in elementSyntaxes {
                rectangularElements.Add(BindExpression(elementSyntax, elementType!!))
            }
            var rectangularLengths = ImmutableArray[int32].Empty
            if elementSyntaxes.Count > 0 {
                let lengths = ImmutableArray.CreateBuilder[int32](boundDimensions.Count)
                var expectedCount int64 = 1
                var allConstant = true
                for dimension in boundDimensions {
                    if !(dimension is BoundLiteralExpression{Value: int32 dimensionLength}) || dimensionLength < 0 {
                        allConstant = false
                        break
                    }
                    lengths.Add(dimensionLength)
                    expectedCount = if dimensionLength == 0 {
                        int64(0)
                    } else {
                        (
                            if expectedCount > int64.MaxValue / int64(dimensionLength) {
                                int64.MaxValue
                            } else {
                                expectedCount * int64(dimensionLength)
                            }
                        )
                    }
                }
                if !allConstant {
                    Diagnostics.ReportRectangularArrayInitializerRequiresConstantDimensions(syntax.Location)
                } else {
                    rectangularLengths = lengths.MoveToImmutable()
                    if expectedCount != int64(elementSyntaxes.Count) {
                        Diagnostics.ReportRectangularArrayInitializerLengthMismatch(
                            syntax.Location,
                            expectedCount,
                            elementSyntaxes.Count
                        )
                    }
                }
            }
            return BoundArrayCreationExpression.CreateRectangular(
                syntax,
                RectangularArrayTypeSymbol.Get(elementType!!, dimensions.Count),
                boundDimensions.MoveToImmutable(),
                rectangularElements.MoveToImmutable(),
                rectangularLengths
            )
        }
        // Issue #1272: the runtime/zero-initialised allocation form `[n]T`
        // (and the empty-initializer spelling `[n]T{}`). The length is an
        // arbitrary expression converted to int32 (mirroring how array indices
        // and `newarr` lengths are typed); the result is a zero-initialised
        // slice `[]T` of length `n` produced by the `newarr` emitter path.
        if syntax.LengthExpression != nil {
            let boundLength = conversions.BindConversion(syntax.LengthExpression, TypeSymbol.Int32)
            return BoundArrayCreationExpression(syntax, SliceTypeSymbol.Get(elementType), boundLength)
        }
        for elementSyntax in elementSyntaxes {
            elements.Add(BindExpression(elementSyntax, elementType!!))
        }
        if syntax.LengthToken == nil {
            return BoundArrayCreationExpression(nil, SliceTypeSymbol.Get(elementType), elements.ToImmutable())
        }
        if !int32.TryParse(syntax.LengthToken!!.Text, out var length) || length < 0 {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken!!.Location, syntax.LengthToken!!.Text)
            return BoundErrorExpression(nil)
        }
        if elementSyntaxes.Count != length {
            Diagnostics.ReportArrayLiteralLengthMismatch(syntax.Location, length, elementSyntaxes.Count)
        }
        return BoundArrayCreationExpression(nil, ArrayTypeSymbol.Get(elementType, length), elements.ToImmutable())
    }

    /// Issue #3096: binds a count-inferred array literal containing one or more
    /// native `...source` elements. A hidden (cref:List{T}) receives
    /// fixed elements and each spread's elements in lexical order, then
    /// `ToArray()` yields the slice value.
    private func BindSpreadArrayCreationExpression(
        syntax ArrayCreationExpressionSyntax,
        elementType TypeSymbol
    ) BoundExpression {
        let construction = CreateSpreadListConstruction(syntax, elementType, out var listType)
        let tempName = "$$spreadbuilder" + Interlocked.Increment(&binderCtx.SyntheticLocalCounter).ToString(
            CultureInfo.InvariantCulture
        )
        let temp = LocalVariableSymbol(tempName, isReadOnly: false, listType)
        $scope.TryDeclareVariable(temp)
        let statements = ImmutableArray.CreateBuilder[BoundStatement]()
        statements.Add(BoundVariableDeclaration(syntax, temp, construction))
        for element in syntax.Elements ??
            GSharp
            .Core
            .CodeAnalysis
            .Syntax
            .SeparatedSyntaxList[ExpressionSyntax](ImmutableArray[SyntaxNode].Empty) {
            if element is SpreadElementExpressionSyntax spread {
                statements.AddRange(BindCollectionSpreadStatements(temp, spread))
                continue
            }
            statements.Add(
                BoundExpressionStatement(element, BindCollectionAddCall(temp, element, ImmutableArray.Create(element)))
            )
        }
        let receiver = BoundVariableExpression(syntax, temp)
        let toArray = BindAccessorCall(
            receiver,
            classSymbol: nil,
            SynthesizeInstanceCall(syntax, "ToArray", ImmutableArray[ExpressionSyntax].Empty)
        )
        let result = conversions.BindConversion(syntax.Location, toArray, SliceTypeSymbol.Get(elementType))
        return BoundBlockExpression(syntax, statements.ToImmutable(), result)
    }

    private func CreateSpreadListConstruction(
        syntax SyntaxNode,
        elementType TypeSymbol,
        out listType ImportedTypeSymbol
    ) BoundExpression {
        let openListType = $scope.References!!.MapClrTypeToReferences(typeof(List[_]))
        var clrElementType Type? = resolveClrTypeForGenericArg(elementType)
        if clrElementType == nil && MemberLookup.TryProjectErasedClrType(elementType, out var projectedElementType) {
            clrElementType = $scope.References!!.MapClrTypeToReferences(projectedElementType)
        }
        clrElementType ??= $scope.References!!.GetCoreType("System.Object")
        var closedListType Type
        try {
            closedListType = openListType!!.MakeGenericType(clrElementType!!)
        } catch (ArgumentException) {
            closedListType = openListType!!.MakeGenericType($scope.References!!.GetCoreType("System.Object"))
        }
        listType = ImportedTypeSymbol.GetConstructed(closedListType, openListType, ImmutableArray.Create(elementType))
        let constructor = Invariant.Required(
            FindPublicParameterlessConstructor(closedListType),
            "List<T> has a public parameterless constructor",
            expression: "FindPublicParameterlessConstructor(closedListType)"
        )
        return BoundClrConstructorCallExpression(
            syntax,
            closedListType,
            constructor,
            ImmutableArray[BoundExpression].Empty,
            listType
        )
    }

    /// ADR-0124 / issues #1024, #1057, #1041: binds a stack-allocation
    /// expression in G#-style array grammar `stackalloc [n]T`. The default
    /// (safe) result is a `System.Span<T>` over the `localloc`'d
    /// memory and needs no `unsafe` context. When
    /// [`targetType`](paramref) is an unmanaged pointer `*T` (only
    /// spellable inside an `unsafe` context, ADR-0122) whose pointee
    /// matches `T`, the raw `T*` pointer is produced instead. An
    /// optional initializer (`stackalloc [n]T{a, b, …}` or the
    /// count-inferred `stackalloc []T{a, b, …}`) supplies the element
    /// values; each must be convertible to `T` and the buffer length is
    /// the initializer length.
    /// @param syntax The stackalloc syntax.
    /// @param targetType The contextual target type, or `null`.
    /// @returns The bound stackalloc expression.
    internal func BindStackAllocExpression(
        syntax StackAllocExpressionSyntax,
        targetType TypeSymbol? = nil
    ) BoundExpression {
        let elementType TypeSymbol? = lookupTypeToken(syntax.ElementTypeIdentifier)
        if elementType == nil {
            Diagnostics.ReportUndefinedType(
                syntax.ElementTypeIdentifier.Location,
                syntax.ElementTypeIdentifier.ValueText
            )
            return BoundErrorExpression(nil)
        }
        if elementType == TypeSymbol.Error {
            return BoundErrorExpression(nil)
        }
        // The element type must be unmanaged: the buffer is raw, contiguous,
        // GC-untracked stack memory, so a managed reference (or a type
        // structurally containing one) cannot live in it. Reuse the generic
        // constraint classifier so `T unmanaged` is accepted while `T struct`
        // and unconstrained `T` remain rejected.
        if !Binder.IsUnmanagedTypeForConstraint(elementType) {
            Diagnostics.ReportStackAllocElementTypeNotBlittable(syntax.ElementTypeIdentifier.Location, elementType.Name)
            return BoundErrorExpression(nil)
        }
        // Issue #1041: bind the optional brace-delimited initializer. Each
        // element is converted to the element type T; the buffer length is the
        // number of initializer elements.
        var initializerElements = ImmutableArray[BoundExpression].Empty
        if syntax.HasInitializer {
            let initializerSyntaxes = Invariant.Required(
                syntax.Elements,
                "a stackalloc initializer has elements",
                expression: "syntax.Elements"
            )
            let builder = ImmutableArray.CreateBuilder[BoundExpression](initializerSyntaxes.Count)
            for elementSyntax in initializerSyntaxes {
                builder.Add(conversions.BindConversion(elementSyntax, elementType))
            }
            initializerElements = builder.ToImmutable()
        }
        var count BoundExpression
        if syntax.IsCountInferred {
            // Count-inferred `stackalloc []T{ … }`: the length comes from the
            // initializer. Without an initializer the length is undeterminable.
            if !syntax.HasInitializer {
                Diagnostics.ReportStackAllocCountInferredWithoutInitializer(syntax.Location)
                return BoundErrorExpression(nil)
            }
            count = BoundLiteralExpression(nil, initializerElements.Length, TypeSymbol.Int32)
        } else if syntax.HasInitializer {
            // Explicit count with an initializer: the two must agree, as in C#.
            let boundCount = conversions.BindConversion(
                Invariant.Required(
                    syntax.CountExpression,
                    "an explicit stackalloc count has an expression",
                    expression: "syntax.CountExpression"
                ),
                TypeSymbol.Int32
            )
            if TryGetConstantInt32(boundCount, out var explicitCount) && explicitCount != initializerElements.Length {
                Diagnostics.ReportStackAllocInitializerLengthMismatch(
                    syntax.Location,
                    explicitCount,
                    initializerElements.Length
                )
            }
            // The allocated buffer holds exactly the initializer elements.
            count = BoundLiteralExpression(nil, initializerElements.Length, TypeSymbol.Int32)
        } else {
            // Count-only `stackalloc [n]T`: a full (possibly runtime) expression.
            count = conversions.BindConversion(
                Invariant.Required(
                    syntax.CountExpression,
                    "a stackalloc count has an expression",
                    expression: "syntax.CountExpression"
                ),
                TypeSymbol.Int32
            )
        }
        // Unsafe pointer form: only when the declaration target is an unmanaged
        // pointer `*T`. A PointerTypeSymbol can only be produced inside an
        // unsafe context (ADR-0122), so the unsafe gating is intrinsic.
        if targetType is PointerTypeSymbol {
            let pointerType = PointerTypeSymbol.Get(elementType)
            return BoundStackAllocExpression(
                syntax,
                pointerType,
                elementType,
                count,
                isPointerForm: true,
                initializerElements
            )
        }
        // Safe form: yield a Span<T> over the allocated memory. Keep the open
        // type and concrete reflection argument in the resolver's load context;
        // retain the bound element symbol so open/same-compilation arguments
        // remain symbolic for emit.
        let spanOpen = this.binderCtx.References.MapClrTypeToReferences(typeof(System.Span[_]))
        let elementClr = if elementType.ClrType != nil {
            this.binderCtx.References.MapClrTypeToReferences(elementType.ClrType)!!
        } else {
            this.binderCtx.References.GetCoreType("System.Object")
        }
        let spanType = ImportedTypeSymbol.GetConstructed(
            spanOpen!!.MakeGenericType(elementClr),
            spanOpen,
            ImmutableArray.Create(elementType)
        )
        return BoundStackAllocExpression(
            syntax,
            spanType,
            elementType,
            count,
            isPointerForm: false,
            initializerElements
        )
    }

    private func BindMapCreationExpression(syntax MapCreationExpressionSyntax) BoundExpression {
        // ADR-0104: bind `map[K,V]{k1: v1, k2: v2, …}`.
        let mapType TypeSymbol? = bindTypeClause(syntax.TypeClause)
        if mapType == nil {
            return BoundErrorExpression(nil)
        }
        if mapType is not MapTypeSymbol mts {
            // Defensive — the parser only produces a map type clause here.
            Diagnostics.ReportUndefinedType(syntax.TypeClause.Location, mapType.Name)
            return BoundErrorExpression(nil)
        }
        let entries = ImmutableArray.CreateBuilder[BoundMapEntry](syntax.Entries.Count)
        for entrySyntax in syntax.Entries {
            let key = BindExpression(entrySyntax.Key, mts.KeyType)
            let value = BindExpression(entrySyntax.Value, mts.ValueType)
            entries.Add(BoundMapEntry(key, value))
        }
        return BoundMapLiteralExpression(nil, mts, entries.ToImmutable())
    }

    shared {
        /// Issue #3678: the type-parameter count of a source generic type
        /// DEFINITION (never a constructed instantiation, whose type arguments are
        /// already supplied), or `-1` for anything else.
        /// @param type The candidate type.
        /// @returns The definition's arity, or `-1`.
        private func DeclaredGenericDefinitionArity(type TypeSymbol) int32 -> switch type {
            case StructSymbol{IsGenericDefinition: true} structSymbol: structSymbol.TypeParameters.Length
            case InterfaceSymbol{IsGenericDefinition: true} interfaceSymbol: interfaceSymbol.TypeParameters.Length
            case DelegateTypeSymbol{IsGenericDefinition: true} delegateSymbol: delegateSymbol.TypeParameters.Length
            default: -1
        }

        /// Issue #3677: whether a segment of a dotted open-generic
        /// `typeof(...)` target resolved to a type whose declared shape
        /// matches what the spelling asked for — a generic DEFINITION of exactly
        /// [`arity`](paramref) type parameters when the segment carried
        /// `_` placeholders, and a non-generic (or already-constructed) type
        /// when it carried none. Without the negative half a segment written
        /// without placeholders could silently pick up a generic homonym.
        /// @param type The type the segment resolved to.
        /// @param arity The segment's requested arity, or -1 when it carried no placeholders.
        /// @returns Whether the resolved type matches the requested shape.
        private func DeclaredSegmentShapeMatches(type TypeSymbol, arity int32) bool -> if arity < 0 {
            DeclaredGenericDefinitionArity(type) < 0
        } else {
            DeclaredGenericDefinitionArity(type) == arity
        }

        /// Issue #3677: whether the dotted segments BEFORE the segment that named
        /// the chain head spell that head's declaring package — either in full
        /// (`Demo.Binding.Fixtures.IQuery[_]`) or as the trailing part of it
        /// (`Fixtures.IQuery[_]` from inside `Demo.Binding`), which is the
        /// relative form C# namespace qualification translates to and the shape
        /// migrated code overwhelmingly uses. Leading segments have to be skipped
        /// for a package qualifier to resolve at all, but skipping them unchecked
        /// would accept any prefix whatsoever
        /// (`typeof(Nonsense.Fixtures.IQuery[_])`).
        /// @param head The type the head segment resolved to.
        /// @param names The raw per-segment names, outermost first.
        /// @param headIndex The index of the segment that named [`head`](paramref).
        /// @returns Whether the skipped prefix names the declaring package.
        private func PrefixMatchesDeclaringPackage(head TypeSymbol, names[]string, headIndex int32) bool {
            if headIndex == 0 {
                return true
            }
            let declaringPackage string? = switch head {
                case structSymbol is StructSymbol: structSymbol.PackageName
                case interfaceSymbol is InterfaceSymbol: interfaceSymbol.PackageName
                case enumSymbol is EnumSymbol: enumSymbol.PackageName
                case delegateSymbol is DelegateTypeSymbol: delegateSymbol.PackageName
                default: default(string?)
            }
            if declaringPackage == nil {
                return false
            }
            let prefix = string.Join(".", names, 0, headIndex)
            return string.Equals(prefix, declaringPackage, StringComparison.Ordinal) || declaringPackage.EndsWith(
                "." + prefix,
                StringComparison.Ordinal
            )
        }

        /// Issue #1989: consecutive-arity-miss streak that stops the upward
        /// arity walk in (cref:TryResolveOpenGenericImportedType). Issue
        /// #2012 (N2): this assumes CONTIGUOUS arity families (no gaps) — see
        /// the walk's comment for details on why that's safe today.
        private const MaxConsecutiveArityMisses int32 = 2

        private func TryExtractNameOfName(argument ExpressionSyntax, out name string?) bool {
            switch argument {
                case n is NameExpressionSyntax {
                    {
                        let ident = n.IdentifierToken.ValueText
                        if string.IsNullOrEmpty(ident) || ident == "this" || ident == "it" {
                            name = nil
                            return false
                        }
                        name = ident
                        return true
                    }
                }
                case acc is AccessorExpressionSyntax when !acc.IsNullConditional {
                    return TryExtractNameOfName(acc.RightPart, out name)
                }
                case call is CallExpressionSyntax when call.TypeArgumentList != nil && call.Arguments.Count == 0 {
                    // Generic name like `List[int]` parsed as an empty-arg generic
                    // call site is treated as a type reference whose short name is
                    // the identifier (matches C# `nameof(List<int>)` -> "List").
                    name = call.Identifier.ValueText
                    return !string.IsNullOrEmpty(name)
                }
                case generic is GenericNameExpressionSyntax {
                    // Issue #1329: a constructed-generic *type* reference such as
                    // `IAppleData[TData]`, `List[int32]` or `Dictionary[string, int32]`
                    // is parsed (issue #1323) as a GenericNameExpression. `nameof` of
                    // a generic type yields the unqualified type name with the type
                    // arguments dropped (matches C# `nameof(List<int>)` -> "List").
                    name = generic.Identifier.ValueText
                    return !string.IsNullOrEmpty(name)
                }
                case p is ParenthesizedExpressionSyntax {
                    return TryExtractNameOfName(p.Expression, out name)
                }
                default {
                    name = nil
                    return false
                }
            }
        }

        /// Issue #4133 (hot-core translation guard finding): builds the
        /// parallel method-group-slot flags for [`arguments`](paramref)
        /// against a symbolic-argument vector of length
        /// [`totalSlots`](paramref), merging in whatever the
        /// `RefineSymbolicArgsForMethodGroups` method-group-slots overload
        /// already discovered ([`refinedSlots`](paramref)) with a direct
        /// (cref:BoundMethodGroupExpression) check on each source
        /// argument. The direct check is needed on its own: a method group with
        /// a single, unambiguous candidate is substituted with its natural
        /// (cref:FunctionTypeSymbol) earlier, while the vector is first
        /// built (`TryGetSymbolicUserMethodGroupType`, before the resolved
        /// method — and therefore the refined vector — exists), so
        /// `RefineSymbolicArgsForMethodGroups` sees an already-recovered
        /// slot and has nothing left to refine; only an OVERLOADED group (whose
        /// arity disambiguation needs the resolved candidate) is ever caught by
        /// its own tracking. Every method-group argument needs the same
        /// downstream demotion in `BuildSymbolicMethodTypeArgs` regardless
        /// of which of the two steps produced its natural type.
        private func MergeMethodGroupArgumentSlots(
            arguments ImmutableArray[BoundExpression],
            receiverArgCount int32,
            totalSlots int32,
            refinedSlots ImmutableArray[bool]
        ) ImmutableArray[bool] {
            if arguments.IsDefaultOrEmpty {
                return refinedSlots
            }
            var merged ImmutableArray[bool].Builder? = nil
            for var i = 0; i < arguments.Length; i++ {
                let slot = i + receiverArgCount
                if slot >= totalSlots || !(arguments[i] is BoundMethodGroupExpression) {
                    continue
                }
                merged ??= if !refinedSlots.IsDefault {
                    refinedSlots.ToBuilder()
                } else {
                    ImmutableArray.CreateBuilder[bool](totalSlots)
                }
                while merged!!.Count < totalSlots {
                    merged!!.Add(false)
                }
                merged!![slot] = true
            }
            return merged?.MoveToImmutable() ?? refinedSlots
        }

        /// Issue #3712: picks the single non-generic candidate of a user method
        /// group. A group with one candidate resolves unconditionally; an
        /// overloaded group resolves only when [`expectedParameterCount`](paramref)
        /// selects exactly one candidate by arity.
        /// @param group The bound method group.
        /// @param expectedParameterCount Optional target-delegate arity.
        /// @param candidate The selected candidate, on success.
        /// @returns `true` when exactly one candidate was selected.
        private func TryGetUniqueSymbolicMethodGroupCandidate(
            group BoundMethodGroupExpression,
            expectedParameterCount int32?,
            @NotNullWhen(true) out candidate FunctionSymbol?
        ) bool {
            candidate = nil
            if group.Candidates.Length == 1 {
                candidate = if group.Candidates[0] is {IsGeneric: false} single {
                    single
                } else {
                    default(FunctionSymbol?)
                }
                return candidate != nil
            }
            if expectedParameterCount is not{} arity {
                return false
            }
            for groupCandidate in group.Candidates {
                if groupCandidate.IsGeneric {
                    continue
                }
                let offset = if groupCandidate.IsExtension && group.Receiver != nil {
                    1
                } else {
                    0
                }
                if groupCandidate.Parameters.Length - offset != arity {
                    continue
                }
                if candidate != nil {
                    // Ambiguous by arity alone — leave the group unresolved so the
                    // existing erasure path decides.
                    candidate = nil
                    return false
                }
                candidate = groupCandidate
            }
            return candidate != nil
        }

        /// Determines whether [`type`](paramref) is the contextual target type
        /// that triggers ADR-0055 Tier 4 lowering — `System.IFormattable` or
        /// `System.FormattableString`. Compared by full name so the check is
        /// robust to metadata-load-context type identity.
        internal func IsFormattableStringTargetType(type TypeSymbol) bool {
            let fullName = type?.ClrType?.FullName
            return fullName == "System.FormattableString" || fullName == "System.IFormattable"
        }

        /// ADR-0055 Tier 4 (#369): builds the per-argument flags consumed by
        /// (cref:ClrOverloadResolution.Resolve{T}),
        /// marking each positional argument whose syntax is an interpolated-string
        /// literal. These arguments may convert to an
        /// `IFormattable`/`FormattableString` parameter in addition to
        /// their natural `string` type. Returns `null` when no
        /// argument qualifies so callers pay nothing on the common path.
        /// @param argumentSyntax The call's source-order argument syntax.
        /// @param count The total argTypes/parameter-slot count that the
        /// returned flags array is indexed against (see [`receiverArgCount`](paramref)).
        /// @param receiverArgCount Issue #1812: the number of leading argTypes/parameter slots that precede
        /// the user-supplied arguments — e.g. 1 for an extension-method call, which
        /// dispatches as `Class.Method(receiver, userArgs…)` so slot 0 is the
        /// receiver and [`argumentSyntax`](paramref)[i] lands at flags[i +
        /// receiverArgCount]. Mirrors the offset already threaded through
        /// (cref:RebindFormattableInterpolationArguments) for the same shape.
        private func ComputeInterpolatedStringArgFlags(
            argumentSyntax GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
            count int32,
            receiverArgCount int32 = 0
        ) IReadOnlyList[bool]? {
            var flags[]?bool = nil
            let limit = Math.Min(count - receiverArgCount, argumentSyntax.Count)
            for var i = 0; i < limit; i++ {
                // Issue #377 sub-item 5: an interpolated string passed as a named
                // argument (`M(arg: $"…")`) is wrapped by NamedArgumentExpressionSyntax.
                // Unwrap before classifying so target typing to
                // IFormattable/FormattableString flows through named arguments too.
                let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i])
                if argSyntax is InterpolatedStringExpressionSyntax {
                    flags ??= [count]bool
                    flags!![i + receiverArgCount] = true
                }
            }
            return flags
        }

        private func AppendEscapedLiteral(builder StringBuilder, text string) {
            for c in text {
                if c == '{' || c == '}' {
                    builder.Append(c)
                }
                builder.Append(c)
            }
        }

        private func Concat(left BoundExpression, right BoundExpression) BoundExpression {
            let op = Invariant.Required(
                BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.String, TypeSymbol.String),
                "string concatenation has a binary operator",
                expression: "BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.String, TypeSymbol.String)"
            )
            return BoundBinaryExpression(nil, left, op, right)
        }

        /// Determines whether an anonymous-object literal is "rich" — i.e. it
        /// carries a base/interface clause, a method, or an event — and therefore
        /// must be lowered through the synthesized-class pipeline rather than the
        /// field-only (cref:AnonymousTypeCache) synthesis.
        private func IsRichAnonymousObject(syntax AnonymousClassExpressionSyntax) bool {
            if syntax.HasBaseType {
                return true
            }
            for member in syntax.Members {
                if member is FunctionDeclarationSyntax || member is EventDeclarationSyntax {
                    return true
                }
            }
            return false
        }

        /// Issue #4024 (review finding 4): returns `true` when every
        /// retained symbolic type argument nonetheless has a FAITHFUL closed CLR
        /// type, so `MakeGenericType` over the projected arguments yields the
        /// real constructed type and members bound off it are correct.
        ///
        /// Retention has two quite different causes, and only one of them
        /// invalidates the closed CLR shape. An argument with no CLR type of its own
        /// — an in-scope type parameter, or a same-compilation user type still being
        /// built — is projected onto the `object` SURROGATE, so a literal bound
        /// off `Box<object>` would read every member as `object`;
        /// those must still bail. An argument that is merely NON-INJECTIVE — a slice
        /// or fixed array (both backed by the one SZ-array `T[]`, #3962/#4024)
        /// or a named tuple (backed by the unnamed `ValueTuple`, ADR-0172) —
        /// has a real closed CLR type; the symbolic vector records identity the CLR
        /// cannot express, beside a shape that is perfectly usable.
        /// @param symbolicArguments The retained symbolic type arguments.
        /// @returns `true` when every argument has a faithful closed CLR type.
        private func HasOnlyClrFaithfulSymbolicArguments(symbolicArguments ImmutableArray[TypeSymbol]) bool {
            if symbolicArguments.IsDefaultOrEmpty {
                return false
            }
            for argument in symbolicArguments {
                if argument.ClrType == nil || TypeSymbol.RequiresSymbolicProjection(argument) {
                    return false
                }
            }
            return true
        }

        private func FindPublicParameterlessConstructor(clrType Type) ConstructorInfo? {
            for constructor in ClrTypeUtilities.SafeGetConstructors(
                clrType,
                BindingFlags.Public | BindingFlags.Instance
            ) {
                if constructor.GetParameters().Length == 0 {
                    return constructor
                }
            }
            return nil
        }

        private func GetStructFieldZeroValue(syntax SyntaxNode, type StructSymbol, field FieldSymbol) BoundExpression? {
            let clrType = type.ClrType
            if clrType == nil {
                return MagicCollectionZeroValue.TrySynthesizeEmptyInstance(syntax, field.Type)
            }
            // Imported declaration initializers are not mandatory collection zero values.
            if ImportedAssemblySemantics.TryGetMagicCollectionFields(clrType, out var kinds) && kinds!!.TryGetValue(
                field.Name,
                out var kind
            ) {
                return MagicCollectionZeroValue.TrySynthesizeEmptyInstanceFromMarker(
                    clrType.GetField(field.Name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance),
                    kind,
                    field.Type
                )
            }
            return nil
        }

        /// Issue #377 sub-item 2: returns true for argument expressions that are
        /// safe to evaluate more than once (no observable side effect, no temp
        /// needed).
        private func IsSideEffectFreeForHandlerCapture(expression BoundExpression) bool {
            return switch expression {
                case _ is BoundLiteralExpression: true
                case _ is BoundVariableExpression: true
                default: false
            }
        }

        /// Issue #377 sub-item 2: wraps a call expression with a
        /// (cref:BoundBlockExpression) that evaluates the prelude
        /// statements (forwarded-arg temp captures) before the call. Returns
        /// [`call`](paramref) unchanged when the prelude is empty.
        private func WrapWithHandlerPrelude(
            call BoundExpression,
            prelude ImmutableArray[BoundStatement],
            syntax SyntaxNode
        ) BoundExpression {
            if prelude.IsDefaultOrEmpty {
                return call
            }
            return BoundBlockExpression(syntax, prelude, call)
        }

        private func TryGetConstantInt32(expression BoundExpression, out value int32) bool {
            var current = expression
            while current is BoundConversionExpression conversion {
                current = conversion.Expression
            }
            if current is BoundLiteralExpression{Value: int32 i} {
                value = i
                return true
            }
            value = 0
            return false
        }
    }
}
