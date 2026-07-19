// <copyright file="ExpressionBinder.Literals.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1516 // Elements should be separated by blank line

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class ExpressionBinder
{
    private BoundExpression BindMakeChannelExpression(MakeChannelExpressionSyntax syntax)
    {
        // Phase 5.4 / ADR-0022: `make(chan T)` / `make(chan T, capacity)`.
        // ADR-0082 / issue #722: the inner `chan` type clause carries the
        // gate via BindTypeClause, so this site reports once via the
        // `chan` form rather than once at `make` *and* once at `chan` (the
        // user typically sees a single offending mistake — needing the
        // import — and one diagnostic is plenty).
        var typeSymbol = bindTypeClause(syntax.ChannelTypeClause);
        if (typeSymbol is not ChannelTypeSymbol chan)
        {
            return new BoundErrorExpression(null);
        }

        BoundExpression capacity = null;
        if (syntax.Capacity != null)
        {
            capacity = conversions.BindConversion(syntax.Capacity, TypeSymbol.Int32);
        }

        return new BoundMakeChannelExpression(null, chan, capacity);
    }

    internal BoundExpression BindTypeOfExpression(TypeOfExpressionSyntax syntax)
    {
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
        var typeClause = syntax.TypeClause;
        TypeSymbol typeSymbol = null;
        if (!typeClause.HasQualifier && !typeClause.IsArray && !typeClause.IsNullable)
        {
            if (!typeClause.HasTypeArguments)
            {
                TryResolveOpenGenericImportedType(typeClause.Identifier.Text, out typeSymbol);
            }
            else if (TryGetUnboundGenericArity(typeClause, out var arity))
            {
                if (!TryResolveOpenGenericImportedTypeWithArity(typeClause.Identifier.Text, arity, out typeSymbol, out var isAmbiguous))
                {
                    // Issue #2012 (N3): "ambiguous across imports" and "no
                    // match at all" are different failure modes and deserve
                    // different diagnostics — ambiguous means too MANY
                    // candidates matched, not that the type is undefined.
                    if (isAmbiguous)
                    {
                        Diagnostics.ReportAmbiguousImportedType(typeClause.Location, typeClause.Identifier.Text + "`" + arity);
                    }
                    else
                    {
                        Diagnostics.ReportUndefinedType(typeClause.Location, typeClause.Identifier.Text + "`" + arity);
                    }

                    return new BoundErrorExpression(null);
                }
            }
        }

        typeSymbol ??= bindTypeClause(syntax.TypeClause);
        if (typeSymbol == null || typeSymbol == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var systemType = ImportedTypeSymbol.Get(typeof(Type));
        return new BoundTypeOfExpression(null, typeSymbol, systemType);
    }

    /// <summary>
    /// Issue #1915: resolves a bare simple name to an imported CLR generic
    /// type's OPEN (unbound) definition — e.g. <c>List</c> with <c>import
    /// System.Collections.Generic</c> resolves to <c>List&lt;&gt;</c> — by
    /// trying each in-scope import's target namespace with an arity-suffixed
    /// (<c>`1</c>, <c>`2</c>, …) reflection name. Returns <see langword="false"/>
    /// when the plain (non-generic) name already resolves to something else
    /// (the ordinary path must always win), or when no unique generic match is
    /// found across every import and arity (an ambiguous or absent match falls
    /// back to the ordinary "type doesn't exist" diagnostic rather than
    /// guessing).
    /// </summary>
    private bool TryResolveOpenGenericImportedType(string name, out TypeSymbol type)
    {
        type = null;
        if (string.IsNullOrEmpty(name) || lookupType(name) != null)
        {
            return false;
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
        Type match = null;
        var missStreak = 0;
        for (var arity = 1; missStreak < MaxConsecutiveArityMisses; arity++)
        {
            var foundAtThisArity = false;
            foreach (var import in scope.GetDeclaredImports())
            {
                var candidateName = import.Target + "." + name + "`" + arity;
                if (scope.References.TryResolveType(candidateName, out var candidate))
                {
                    foundAtThisArity = true;
                    if (match != null && match != candidate)
                    {
                        // Ambiguous across imports/arities — defer to the
                        // ordinary diagnostic rather than guessing.
                        return false;
                    }

                    match = candidate;
                }
            }

            missStreak = foundAtThisArity ? 0 : missStreak + 1;
        }

        if (match == null)
        {
            return false;
        }

        type = TypeSymbol.FromClrType(match);
        return true;
    }

    /// <summary>
    /// Issue #1989: consecutive-arity-miss streak that stops the upward
    /// arity walk in <see cref="TryResolveOpenGenericImportedType"/>. Issue
    /// #2012 (N2): this assumes CONTIGUOUS arity families (no gaps) — see
    /// the walk's comment for details on why that's safe today.
    /// </summary>
    private const int MaxConsecutiveArityMisses = 2;

    /// <summary>
    /// Issue #1989: an unbound-generic <c>typeof(...)</c> target with an
    /// EXPLICIT requested arity, spelled with <c>_</c> placeholder type
    /// arguments (G#'s analogue of C#'s comma-count <c>Name&lt;&gt;</c> /
    /// <c>Name&lt;,&gt;</c> unbound-generic syntax, since G# generics use
    /// <c>Name[T1, T2]</c> brackets rather than angle brackets). Returns
    /// <see langword="true"/> with <paramref name="arity"/> set to the
    /// argument count only when every type argument is a bare <c>_</c> (no
    /// qualifier, nested type arguments, array shape, or nullable suffix) —
    /// any real type argument is an ordinary bound generic and is left to
    /// <see cref="bindTypeClause"/>.
    /// <para>
    /// Issue #2012 (N1): <c>_</c> is an ordinary identifier in G#'s grammar
    /// (it is only special-cased in pattern/discard positions, never
    /// reserved as a type-name token), so user code CAN legally declare a
    /// real type literally named <c>_</c> (<c>class _ {}</c>, <c>type _ =
    /// ...</c>, or a type parameter named <c>_</c>). If such a type is in
    /// scope, treating every <c>_</c> type argument as the unbound-generic
    /// placeholder would silently ignore it and flip <c>Func[_]</c> from
    /// "bound to the real type <c>_</c>" to "unbound <c>Func`1</c>" — a
    /// genuine (if contrived) silent semantic change. So a real type named
    /// <c>_</c> in scope always wins: this method only claims the
    /// placeholder reading when no such type is resolvable, deferring to
    /// <see cref="bindTypeClause"/> otherwise.
    /// </para>
    /// </summary>
    private bool TryGetUnboundGenericArity(TypeClauseSyntax typeClause, out int arity)
    {
        arity = 0;
        var args = typeClause.TypeArguments;
        if (args.Count == 0)
        {
            return false;
        }

        if (lookupType("_") != null)
        {
            // A real type named `_` is in scope (respecting normal
            // shadowing/scoping rules via `lookupType`) — every `_` type
            // argument binds to it as an ordinary type, never the
            // open-generic placeholder.
            return false;
        }

        foreach (var arg in args)
        {
            if (arg.Identifier.Text != "_" || arg.HasQualifier || arg.HasTypeArguments || arg.IsArray || arg.IsNullable)
            {
                return false;
            }
        }

        arity = args.Count;
        return true;
    }

    /// <summary>
    /// Issue #1989: resolves <paramref name="name"/> to an imported CLR
    /// generic type's OPEN definition at the EXACT requested
    /// <paramref name="arity"/> (e.g. <c>Func</c> + arity 2 → <c>Func`2</c>).
    /// Unlike <see cref="TryResolveOpenGenericImportedType"/>, this never
    /// considers the plain non-generic name a match — the caller already
    /// determined the target is an explicit unbound generic — so it can
    /// never silently return the wrong (non-generic) type for names like
    /// <c>Action</c> that have both a non-generic and generic overload set.
    /// </summary>
    /// <param name="name">The bare generic base name (e.g. <c>Func</c>).</param>
    /// <param name="arity">The exact requested arity.</param>
    /// <param name="type">The resolved open-generic type on success.</param>
    /// <param name="isAmbiguous">
    /// Issue #2012 (N3): set to <see langword="true"/> when two or more
    /// imports contribute DIFFERENT candidates at this arity — distinct from
    /// the "no match at all" case — so the caller can raise the correct
    /// ambiguity diagnostic instead of the misleading "type doesn't exist".
    /// </param>
    private bool TryResolveOpenGenericImportedTypeWithArity(string name, int arity, out TypeSymbol type, out bool isAmbiguous)
    {
        type = null;
        isAmbiguous = false;
        if (string.IsNullOrEmpty(name) || arity <= 0)
        {
            return false;
        }

        Type match = null;
        foreach (var import in scope.GetDeclaredImports())
        {
            var candidateName = import.Target + "." + name + "`" + arity;
            if (scope.References.TryResolveType(candidateName, out var candidate))
            {
                if (match != null && match != candidate)
                {
                    // Ambiguous across imports — let the caller raise the
                    // ambiguity diagnostic rather than "type doesn't exist".
                    isAmbiguous = true;
                    return false;
                }

                match = candidate;
            }
        }

        if (match == null)
        {
            return false;
        }

        type = TypeSymbol.FromClrType(match);
        return true;
    }

    internal BoundExpression BindSizeOfExpression(SizeOfExpressionSyntax syntax)
    {
        // Issue #1336: `sizeof(T)` returns the unmanaged byte size of T as an
        // int32, emitted via the CIL `sizeof <T>` opcode (which accepts a
        // generic type token). The operand must be an unmanaged type — a
        // blittable primitive, an enum, a pointer, a blittable value struct, or
        // a generic type parameter constrained `unmanaged`. This mirrors C#'s
        // `sizeof` over unmanaged types and shares the emit path the
        // unmanaged-pointer arithmetic lowering already uses (ADR-0122 §4).
        var typeSymbol = bindTypeClause(syntax.TypeClause);
        if (typeSymbol == null || typeSymbol == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        if (!Binder.IsUnmanagedTypeForConstraint(typeSymbol))
        {
            Diagnostics.ReportSizeOfRequiresUnmanagedType(syntax.TypeClause.Location, typeSymbol.Name);
            return new BoundErrorExpression(null);
        }

        return new BoundSizeOfExpression(null, typeSymbol);
    }

    internal BoundExpression BindDefaultExpression(DefaultExpressionSyntax syntax)
    {
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
        if (syntax.TypeClause == null)
        {
            return new BoundDefaultExpression(syntax, TypeSymbol.Error);
        }

        var typeSymbol = bindTypeClause(syntax.TypeClause);
        if (typeSymbol == null || typeSymbol == TypeSymbol.Error)
        {
            return new BoundErrorExpression(syntax);
        }

        return new BoundDefaultExpression(syntax, typeSymbol);
    }

    private BoundExpression BindNameOfExpression(NameOfExpressionSyntax syntax)
    {
        // Issue #143: `nameof(expr)` is folded to a compile-time string of
        // the unqualified short name. The argument must be a name reference
        // (identifier, member access, or type). `nameof(this)` / `nameof(it)`
        // are rejected to match C# semantics.
        if (TryExtractNameOfName(syntax.Argument, out var name))
        {
            return new BoundLiteralExpression(null, name);
        }

        Diagnostics.ReportNameOfRequiresNameReference(syntax.Argument.Location);
        return new BoundErrorExpression(null);
    }

    private static bool TryExtractNameOfName(ExpressionSyntax argument, out string name)
    {
        switch (argument)
        {
            case NameExpressionSyntax n:
                {
                    var ident = n.IdentifierToken.Text;
                    if (string.IsNullOrEmpty(ident) || ident == "this" || ident == "it")
                    {
                        name = null;
                        return false;
                    }

                    name = ident;
                    return true;
                }

            case AccessorExpressionSyntax acc when !acc.IsNullConditional:
                return TryExtractNameOfName(acc.RightPart, out name);

            case CallExpressionSyntax call when call.TypeArgumentList != null && call.Arguments.Count == 0:
                // Generic name like `List[int]` parsed as an empty-arg generic
                // call site is treated as a type reference whose short name is
                // the identifier (matches C# `nameof(List<int>)` -> "List").
                name = call.Identifier.Text;
                return !string.IsNullOrEmpty(name);

            case GenericNameExpressionSyntax generic:
                // Issue #1329: a constructed-generic *type* reference such as
                // `IAppleData[TData]`, `List[int32]` or `Dictionary[string, int32]`
                // is parsed (issue #1323) as a GenericNameExpression. `nameof` of
                // a generic type yields the unqualified type name with the type
                // arguments dropped (matches C# `nameof(List<int>)` -> "List").
                name = generic.Identifier.Text;
                return !string.IsNullOrEmpty(name);

            case ParenthesizedExpressionSyntax p:
                return TryExtractNameOfName(p.Expression, out name);

            default:
                name = null;
                return false;
        }
    }

    private BoundExpression BindLiteralExpression(LiteralExpressionSyntax syntax)
    {
        // Phase 3.C.2: a literal whose syntax value is null is the `nil`
        // literal — preserve null so BoundLiteralExpression picks the Null
        // sentinel type. All other literals default missing values to 0
        // for legacy parser robustness.
        var value = syntax.Value;
        if (value == null && syntax.LiteralToken.Kind != SyntaxKind.NilKeyword)
        {
            value = 0;
        }

        return new BoundLiteralExpression(null, value);
    }

    private BoundExpression BindInterpolatedStringExpression(InterpolatedStringExpressionSyntax syntax)
    {
        // ADR-0055 (Phase 2): bind `"a $x b ${expr,align:fmt} c"` to a dedicated
        // BoundInterpolatedStringExpression carrying the ordered literal/hole
        // parts. Lowering is deferred (late) so that format/alignment intent is
        // preserved through binding — the interpreter renders the node directly,
        // and the emitter lowers it to the DefaultInterpolatedStringHandler
        // pattern (issue #368). This replaces the legacy eager `+`-chain that
        // mis-asserted `string`/`string?` operand types and produced the #366
        // memory-unsafe IL.
        var parts = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(syntax.Segments.Length);
        foreach (var segment in syntax.Segments)
        {
            if (segment.IsExpression)
            {
                var bound = BindExpression(segment.Expression);
                if (bound is BoundErrorExpression)
                {
                    return bound;
                }

                if (bound.Type == null || bound.Type == TypeSymbol.Void)
                {
                    Diagnostics.ReportCannotConvert(segment.Expression.Location, bound.Type, TypeSymbol.String);
                    return new BoundErrorExpression(null);
                }

                parts.Add(BoundInterpolatedStringPart.FromHole(bound, segment.Alignment, segment.Format));
            }
            else
            {
                parts.Add(BoundInterpolatedStringPart.FromLiteral(segment.Text ?? string.Empty));
            }
        }

        return new BoundInterpolatedStringExpression(syntax, parts.ToImmutable());
    }

    /// <summary>
    /// ADR-0055 Tier 4: lowers an interpolated string whose contextual target
    /// type is <see cref="System.IFormattable"/> or
    /// <see cref="System.FormattableString"/> to
    /// <c>FormattableStringFactory.Create(format, object[])</c>, preserving the
    /// composite format string (alignment/format clauses included) so the caller
    /// can defer formatting and choose a culture at consumption time. The result
    /// is a <see cref="System.FormattableString"/> value, which is reference-
    /// compatible with an <see cref="System.IFormattable"/> target.
    /// </summary>
    internal BoundExpression BindInterpolatedStringAsFormattable(InterpolatedStringExpressionSyntax syntax, TypeSymbol targetType)
    {
        _ = targetType;
        if (!TryBuildInterpolationFormat(syntax, out var composite, out var holeValues))
        {
            return new BoundErrorExpression(null);
        }

        var formatLiteral = new BoundLiteralExpression(null, composite);
        var argArray = BuildObjectArgumentArray(holeValues);

        var factoryType = typeof(System.Runtime.CompilerServices.FormattableStringFactory);
        var createMethod = factoryType.GetMethod("Create", new[] { typeof(string), typeof(object[]) });
        var importedClass = new ImportedClassSymbol(factoryType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(createMethod.Name, importedClass, createMethod, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create<BoundExpression>(formatLiteral, argArray));
    }

    /// <summary>
    /// Determines whether <paramref name="type"/> is the contextual target type
    /// that triggers ADR-0055 Tier 4 lowering — <c>System.IFormattable</c> or
    /// <c>System.FormattableString</c>. Compared by full name so the check is
    /// robust to metadata-load-context type identity.
    /// </summary>
    internal static bool IsFormattableStringTargetType(TypeSymbol type)
    {
        var fullName = type?.ClrType?.FullName;
        return fullName == "System.FormattableString" || fullName == "System.IFormattable";
    }

    /// <summary>
    /// ADR-0055 Tier 4 (#369): builds the per-argument flags consumed by
    /// <see cref="OverloadResolution.Resolve{T}"/>,
    /// marking each positional argument whose syntax is an interpolated-string
    /// literal. These arguments may convert to an
    /// <c>IFormattable</c>/<c>FormattableString</c> parameter in addition to
    /// their natural <c>string</c> type. Returns <see langword="null"/> when no
    /// argument qualifies so callers pay nothing on the common path.
    /// </summary>
    /// <param name="argumentSyntax">The call's source-order argument syntax.</param>
    /// <param name="count">The total argTypes/parameter-slot count that the
    /// returned flags array is indexed against (see <paramref name="receiverArgCount"/>).</param>
    /// <param name="receiverArgCount">
    /// Issue #1812: the number of leading argTypes/parameter slots that precede
    /// the user-supplied arguments — e.g. 1 for an extension-method call, which
    /// dispatches as <c>Class.Method(receiver, userArgs…)</c> so slot 0 is the
    /// receiver and <paramref name="argumentSyntax"/>[i] lands at flags[i +
    /// receiverArgCount]. Mirrors the offset already threaded through
    /// <see cref="RebindFormattableInterpolationArguments"/> for the same shape.
    /// </param>
    private static IReadOnlyList<bool> ComputeInterpolatedStringArgFlags(SeparatedSyntaxList<ExpressionSyntax> argumentSyntax, int count, int receiverArgCount = 0)
    {
        bool[] flags = null;
        var limit = Math.Min(count - receiverArgCount, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            // Issue #377 sub-item 5: an interpolated string passed as a named
            // argument (`M(arg: $"…")`) is wrapped by NamedArgumentExpressionSyntax.
            // Unwrap before classifying so target typing to
            // IFormattable/FormattableString flows through named arguments too.
            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i]);
            if (argSyntax is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i + receiverArgCount] = true;
            }
        }

        return flags;
    }

    /// <summary>
    /// ADR-0055 Tier 4 (#369): after overload resolution selects an imported
    /// method/constructor, re-lowers each interpolated-string argument whose
    /// chosen parameter type is <c>IFormattable</c>/<c>FormattableString</c> to
    /// <c>FormattableStringFactory.Create(...)</c>. Arguments bound against any
    /// other parameter (including <c>string</c>) are left untouched. Returns the
    /// original array unchanged when nothing needs re-lowering.
    /// Issue #1638: <c>receiverArgCount</c> is the number of leading argument
    /// slots reserved for a synthesised receiver (0 for plain calls, 1 for
    /// imported extension calls, which prepend the receiver to both
    /// <c>arguments</c> and <c>parameters</c> but not to <c>argumentSyntax</c>).
    /// Receiver slots are skipped since they have no source syntax to re-lower.
    /// </summary>
    private ImmutableArray<BoundExpression> RebindFormattableInterpolationArguments(
        ImmutableArray<BoundExpression> arguments,
        SeparatedSyntaxList<ExpressionSyntax> argumentSyntax,
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default,
        int receiverArgCount = 0)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        var limit = Math.Min(arguments.Length, argumentSyntax.Count + receiverArgCount);
        for (var i = receiverArgCount; i < limit; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            if (paramIndex >= parameters.Length)
            {
                continue;
            }

            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i - receiverArgCount]);
            if (argSyntax is InterpolatedStringExpressionSyntax interpolated
                && OverloadResolution.IsFormattableStringTarget(parameters[paramIndex].ParameterType))
            {
                builder ??= arguments.ToBuilder();
                builder[i] = BindInterpolatedStringAsFormattable(interpolated, targetType: null);
            }
        }

        return builder?.ToImmutable() ?? arguments;
    }

    /// <summary>
    /// Builds the C#-style composite format string (<c>"{0}"</c>,
    /// <c>"{0,10}"</c>, <c>"{0,-20:N2}"</c>) and the ordered, bound hole values
    /// for an interpolated string. Literal braces are escaped (<c>{</c> →
    /// <c>{{</c>) so they survive <c>String.Format</c>/<c>FormattableString</c>
    /// formatting. Returns <c>false</c> if any hole fails to bind.
    /// </summary>
    private bool TryBuildInterpolationFormat(InterpolatedStringExpressionSyntax syntax, out string composite, out ImmutableArray<BoundExpression> holeValues)
    {
        composite = null;
        holeValues = default;

        var format = new StringBuilder();
        var values = ImmutableArray.CreateBuilder<BoundExpression>();
        foreach (var segment in syntax.Segments)
        {
            if (!segment.IsExpression)
            {
                AppendEscapedLiteral(format, segment.Text ?? string.Empty);
                continue;
            }

            var bound = BindExpression(segment.Expression);
            if (bound is BoundErrorExpression)
            {
                return false;
            }

            var index = values.Count;
            values.Add(bound);

            format.Append('{').Append(index.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (segment.Alignment.HasValue)
            {
                format.Append(',').Append(segment.Alignment.Value.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            if (segment.Format != null)
            {
                format.Append(':').Append(segment.Format);
            }

            format.Append('}');
        }

        composite = format.ToString();
        holeValues = values.ToImmutable();
        return true;
    }

    private static void AppendEscapedLiteral(StringBuilder builder, string text)
    {
        foreach (var c in text)
        {
            if (c == '{' || c == '}')
            {
                builder.Append(c);
            }

            builder.Append(c);
        }
    }

    /// <summary>
    /// Wraps the bound hole values in an <c>object[]</c> creation, boxing value
    /// types via an explicit conversion to <c>object</c> so the emitter produces
    /// verifiable IL (ADR-0055 — no <c>Convert.ToString</c> mis-typing).
    /// </summary>
    private BoundExpression BuildObjectArgumentArray(ImmutableArray<BoundExpression> holeValues)
    {
        var elements = ImmutableArray.CreateBuilder<BoundExpression>(holeValues.Length);
        foreach (var value in holeValues)
        {
            elements.Add(value.Type == TypeSymbol.Object
                ? value
                : new BoundConversionExpression(null, TypeSymbol.Object, value));
        }

        var arrayType = ArrayTypeSymbol.Get(TypeSymbol.Object, holeValues.Length);
        return new BoundArrayCreationExpression(null, arrayType, elements.ToImmutable());
    }

    private BoundExpression BuildStringFormatCall(string composite, ImmutableArray<BoundExpression> holeValues)
    {
        var formatLiteral = new BoundLiteralExpression(null, composite);
        var argArray = BuildObjectArgumentArray(holeValues);

        var stringType = typeof(string);
        var formatMethod = stringType.GetMethod("Format", new[] { typeof(string), typeof(object[]) });
        var importedClass = new ImportedClassSymbol(stringType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(formatMethod.Name, importedClass, formatMethod, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create<BoundExpression>(formatLiteral, argArray));
    }

    private BoundExpression ConvertToString(BoundExpression expression, TextLocation diagnosticLocation)
    {
        if (expression.Type == TypeSymbol.String)
        {
            return expression;
        }

        var clrType = expression.Type?.ClrType;
        if (clrType == null)
        {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, TypeSymbol.String);
            return new BoundErrorExpression(null);
        }

        // Bind a call to `System.Convert.ToString(<expr.Type>)`. Convert.ToString
        // is a static overload set covering every primitive (int, long, bool,
        // double, ...) plus `object`, so it works uniformly without emitter
        // changes for value-type instance dispatch.
        var convertType = typeof(System.Convert);
        var method = convertType.GetMethod("ToString", new[] { clrType })
            ?? convertType.GetMethod("ToString", new[] { typeof(object) });
        if (method == null)
        {
            Diagnostics.ReportCannotConvert(diagnosticLocation, expression.Type, TypeSymbol.String);
            return new BoundErrorExpression(null);
        }

        var importedClass = new ImportedClassSymbol(convertType, declaration: null);
        var importedFn = new ImportedFunctionSymbol(method.Name, importedClass, method, declaration: null);
        return new BoundImportedCallExpression(null, importedFn, ImmutableArray.Create(expression));
    }

    private static BoundExpression Concat(BoundExpression left, BoundExpression right)
    {
        var op = BoundBinaryOperator.Bind(SyntaxKind.PlusToken, TypeSymbol.String, TypeSymbol.String);
        return new BoundBinaryExpression(null, left, op, right);
    }

    /// <summary>
    /// Binds an anonymous-class literal <c>object { let Name = "Foo"; ... }</c>
    /// (issue #2224 / ADR-0146). Unlike <see cref="BindStructLiteralExpression(StructLiteralExpressionSyntax)"/>,
    /// there is no named type to resolve: each distinct ordered
    /// (member-name, member-type) shape gets its own compiler-synthesized
    /// backing <see cref="StructSymbol"/>, cached per compile pass (see
    /// <see cref="AnonymousTypeCache"/>) so two literals with the same shape
    /// share one synthesized type — mirroring how Roslyn unifies
    /// <c>new { ... }</c> anonymous types within one C# compilation. Unlike
    /// C#, each member's type is written explicitly rather than inferred from
    /// its initializer expression; the annotated type is checked against the
    /// initializer exactly like an ordinary <c>let x Type = expr</c>
    /// declaration's type clause (<see cref="StatementBinder.BindVariableDeclaration(VariableDeclarationSyntax)"/>),
    /// so implicit conversions and nullable annotations apply the same way.
    /// </summary>
    /// <param name="syntax">The anonymous-class-literal syntax.</param>
    private BoundExpression BindAnonymousClassExpression(AnonymousClassExpressionSyntax syntax)
    {
        // ADR-0146 / issue #2243: a "rich" anonymous object — one carrying a
        // base/interface clause, methods, or events — was desugared to a
        // compiler-synthesized backing class by the pre-binding pass
        // (Binder.SynthesizeRichAnonymousClasses). Bind the literal site to a
        // parameterless construction of that class; its field initializers and
        // base-constructor forwarding run in the synthesized constructor.
        if (IsRichAnonymousObject(syntax))
        {
            return BindRichAnonymousClassExpression(syntax);
        }

        var seenNames = new HashSet<string>();
        var memberNames = ImmutableArray.CreateBuilder<string>(syntax.Members.Length);
        var memberValues = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Members.Length);
        var hadError = false;
        foreach (var memberNode in syntax.Members)
        {
            if (!(memberNode is AnonymousClassMemberInitializerSyntax member))
            {
                // A method/event in an object with no base clause is still a
                // rich object and handled above; reaching here means an
                // unexpected member node — skip defensively.
                continue;
            }

            var name = member.Identifier.Text;
            if (!seenNames.Add(name))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(member.Identifier.Location, name);
                hadError = true;
                continue;
            }

            // The member type clause is optional (ADR-0146): when present the
            // annotated type wins and the initializer is converted to it
            // (declared-type-wins, like `let x Type = expr`); when absent the
            // member type is inferred from the initializer expression exactly
            // like an ordinary `let x = expr` local declaration.
            var memberType = bindTypeClause(member.TypeClause);
            var value = BindExpression(member.Value);
            if (value is BoundErrorExpression)
            {
                hadError = true;
            }
            else if (memberType != null)
            {
                value = conversions.BindConversion(member.Value.Location, value, memberType);
                if (value is BoundErrorExpression)
                {
                    hadError = true;
                }
            }

            memberNames.Add(name);
            memberValues.Add(value);
        }

        if (hadError || memberNames.Count == 0)
        {
            return new BoundErrorExpression(syntax);
        }

        var shape = new (string Name, TypeSymbol Type)[memberNames.Count];
        for (var i = 0; i < memberNames.Count; i++)
        {
            shape[i] = (memberNames[i], memberValues[i].Type);
        }

        var packageName = this.function?.Package?.Name ?? string.Empty;
        var anonymousType = scope.GetAnonymousTypeCache().GetOrCreate(shape, packageName, useFields: syntax.IsData);

        if (syntax.IsData)
        {
            // ADR-0146 / issue #2243: a `data object { ... }` synthesizes a
            // fields-based value type (data-class style). Emit it as a
            // composite struct literal (initobj + stfld per field) exactly like
            // an ordinary `data struct Foo(x int32)` literal, so value equality,
            // ToString, Deconstruct, and `with`-copy all work off the fields.
            var initializers = ImmutableArray.CreateBuilder<BoundFieldInitializer>(memberValues.Count);
            var fields = anonymousType.Fields;
            for (var i = 0; i < memberValues.Count; i++)
            {
                initializers.Add(new BoundFieldInitializer(fields[i], memberValues[i]));
            }

            return new BoundStructLiteralExpression(syntax, anonymousType, initializers.MoveToImmutable());
        }

        // A plain `object { ... }`'s members are get-only auto-properties with
        // no public field/setter (see AnonymousTypeCache), so it compiles as a
        // primary constructor call (`<>AnonymousTypeN(v1, v2, ...)`) — exactly
        // like C#'s `new { ... }` lowers to a constructor call. This reuses the
        // proven primary-constructor-call and expression-tree lowering paths
        // with no additional emitter code.
        return new BoundConstructorCallExpression(syntax, anonymousType, memberValues.MoveToImmutable());
    }

    /// <summary>
    /// Determines whether an anonymous-object literal is "rich" — i.e. it
    /// carries a base/interface clause, a method, or an event — and therefore
    /// must be lowered through the synthesized-class pipeline rather than the
    /// field-only <see cref="AnonymousTypeCache"/> synthesis.
    /// </summary>
    private static bool IsRichAnonymousObject(AnonymousClassExpressionSyntax syntax)
    {
        if (syntax.HasBaseType)
        {
            return true;
        }

        foreach (var member in syntax.Members)
        {
            if (member is FunctionDeclarationSyntax || member is EventDeclarationSyntax)
            {
                return true;
            }
        }

        return false;
    }

    private BoundExpression BindRichAnonymousClassExpression(AnonymousClassExpressionSyntax syntax)
    {
        // The desugaring pass records the synthesized backing class for each
        // rich anonymous-object literal keyed by syntax-node identity. The
        // literal simply constructs it with no arguments — base-constructor
        // arguments (spliced verbatim into the synthesized `: Base(args)`
        // clause) and field initializers execute inside the synthesized ctor.
        if (scope.GetRichAnonymousClassMap().TryGetValue(syntax, out var classSymbol) && classSymbol != null)
        {
            return new BoundConstructorCallExpression(syntax, classSymbol, ImmutableArray<BoundExpression>.Empty);
        }

        // Defensive: if the desugaring pass produced no symbol (it reported a
        // diagnostic), surface an error node so binding continues.
        return new BoundErrorExpression(syntax);
    }

    private BoundExpression BindStructLiteralExpression(StructLiteralExpressionSyntax syntax)
        => BindStructLiteralExpression(syntax, resolvedDefinition: null);

    /// <summary>
    /// Binds a struct/class literal <c>Foo{ ... }</c>. When
    /// <paramref name="resolvedDefinition"/> is supplied (issue #1174: a
    /// qualified nested type <c>Container.Nested{ ... }</c> whose simple name
    /// collides with a top-level homonym), it is used directly instead of
    /// resolving the type by the literal's simple name — which would otherwise
    /// bind to the top-level homonym holding the simple key.
    /// </summary>
    /// <param name="syntax">The struct-literal syntax.</param>
    /// <param name="resolvedDefinition">The pre-resolved struct definition, or <c>null</c> to resolve by simple name.</param>
    /// <param name="enclosingTypeArguments">
    /// Issue #1521 / #1537: when the literal names a type nested inside a
    /// CONSTRUCTED generic enclosing type (<c>Outer[int32].Middle[string]{…}</c>
    /// or <c>Box[int32].Tag{…}</c>), the flattened enclosing construction's type
    /// arguments (outermost-first). Threaded onto the constructed struct symbol
    /// so member types substitute the enclosing arguments and the emitter
    /// encodes the reified nested type (<c>Outer`1+Middle`2&lt;int32,string&gt;</c>).
    /// </param>
    private BoundExpression BindStructLiteralExpression(
        StructLiteralExpressionSyntax syntax,
        StructSymbol resolvedDefinition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments = default)
    {
        if (syntax.SpreadExpression != null)
        {
            return BindStructuralSpreadLiteral(syntax, resolvedDefinition, enclosingTypeArguments);
        }

        var typeName = syntax.TypeIdentifier.Text;

        StructSymbol structSymbol = null;
        if (resolvedDefinition != null)
        {
            structSymbol = resolvedDefinition;
        }
        else
        {
            // Issue #1051: when the literal carries an explicit type-argument list,
            // resolve the same-named generic definition of the matching arity so a
            // non-generic `Foo` and a generic `Foo[T]` can coexist. Without one,
            // prefer the arity-0 type (falling back to a lone generic for inference).
            var preferredArity = syntax.TypeArgumentList != null ? syntax.TypeArgumentList.Arguments.Count : -1;
            var foundAlias = scope.TryLookupTypeAlias(typeName, preferredArity, out var resolvedType, out var typeNameAmbiguous);
            if (!foundAlias || !(resolvedType is StructSymbol resolvedStruct))
            {
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
                if (!typeNameAmbiguous
                    && syntax.TypeArgumentList == null
                    && scope.TryLookupImportedClass(typeName, declaration: null, out var importedClass)
                    && importedClass.ClassType is { IsGenericTypeDefinition: false })
                {
                    if (ImportedTypeSymbol.TryCreateSemanticAggregate(importedClass.ClassType, scope.References, out var importedAggregate))
                    {
                        structSymbol = importedAggregate;
                    }
                    else
                    {
                        return BindImportedTypeLiteralExpression(syntax, importedClass.ClassType);
                    }
                }
                else if (!typeNameAmbiguous && syntax.TypeArgumentList == null && lookupType(typeName) is TypeParameterSymbol tpLiteral)
                {
                    // Issue #988 / #1235 (object-initializer follow-up): `T{Field: value,
                    // ...}` constructs the type parameter `T` — mirroring C#'s
                    // `new T { Field = value }` for a generic method constrained
                    // `where T : class, new()` — when the enclosing generic declares
                    // the `init()` default-constructor constraint. Lowered to a
                    // reified `Activator.CreateInstance<T>()` construction followed by
                    // member assignments through the constraint's field/property
                    // surface (see BindTypeParameterObjectInitializer).
                    if (!tpLiteral.HasDefaultConstructorConstraint)
                    {
                        Diagnostics.ReportConstructedTypeParameterRequiresNewConstraint(syntax.TypeIdentifier.Location, tpLiteral.Name);
                        foreach (var initSyntax in syntax.Initializers)
                        {
                            _ = BindExpression(initSyntax.Value);
                        }

                        return new BoundErrorExpression(null);
                    }

                    return BindTypeParameterObjectInitializer(syntax, tpLiteral);
                }
                else if (structSymbol == null && typeNameAmbiguous)
                {
                    Diagnostics.ReportAmbiguousSourceType(syntax.TypeIdentifier.Location, typeName);
                    return new BoundErrorExpression(null);
                }
                else if (structSymbol == null)
                {
                    Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName);
                    return new BoundErrorExpression(null);
                }
            }
            else
            {
                structSymbol = resolvedStruct;
            }
        }

        // ADR-0047 §6 / #175: struct/class literal `Foo{ ... }` is a
        // use of the named type.
        reportObsoleteUseIfApplicable(syntax.TypeIdentifier.Location, structSymbol, structSymbol.Name);

        // Phase 4.3 / ADR-0020: if the declared struct is generic, build a
        // type-argument substitution (explicit or inferred from initializers)
        // and construct a closed StructSymbol to bind against. Constructed
        // instances are cached so reference-equality of TypeSymbols is
        // preserved (e.g. `Result[int, string]` always returns the same
        // StructSymbol object).
        if (structSymbol.IsGenericDefinition)
        {
            Dictionary<TypeParameterSymbol, TypeSymbol> substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
            var tps = structSymbol.TypeParameters;

            if (syntax.TypeArgumentList != null)
            {
                var explicitArgs = syntax.TypeArgumentList.Arguments;
                if (explicitArgs.Count != tps.Length)
                {
                    Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, typeName, tps.Length, explicitArgs.Count);
                    return new BoundErrorExpression(null);
                }

                for (var i = 0; i < explicitArgs.Count; i++)
                {
                    var ta = bindTypeClause(explicitArgs[i]);
                    if (ta == null)
                    {
                        return new BoundErrorExpression(null);
                    }

                    substitution[tps[i]] = ta;
                }
            }
            else
            {
                // Infer from the initializer expression types matched against
                // the corresponding field's declared type (first-seen wins,
                // consistent with Phase 4.1 call-site inference).
                foreach (var initSyntax in syntax.Initializers)
                {
                    TypeSymbol memberType;
                    if (TypeMemberModel.TryGetFieldIncludingInherited(structSymbol, initSyntax.FieldIdentifier.Text, MemberQuery.Instance(MemberKinds.Field), out var field, out _))
                    {
                        memberType = field.Type;
                    }
                    else if (TypeMemberModel.TryGetProperty(structSymbol, initSyntax.FieldIdentifier.Text, out var property))
                    {
                        memberType = property.Type;
                    }
                    else
                    {
                        continue;
                    }

                    var valueExpr = BindExpression(initSyntax.Value);
                    Binder.InferTypeArguments(memberType, valueExpr.Type, substitution);
                }

                foreach (var tp in tps)
                {
                    if (!substitution.ContainsKey(tp))
                    {
                        Diagnostics.ReportTypeArgumentInferenceFailed(syntax.TypeIdentifier.Location, typeName, tp.Name);
                        return new BoundErrorExpression(null);
                    }
                }
            }

            // Phase 4.2 constraint satisfaction.
            var constraintLocation = syntax.TypeArgumentList != null
                ? syntax.TypeArgumentList.Location
                : syntax.TypeIdentifier.Location;
            foreach (var tp in tps)
            {
                var typeArg = substitution[tp];
                if (!Binder.SatisfiesConstraint(typeArg, tp))
                {
                    Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(constraintLocation, tp.Name, typeArg, Binder.DescribeConstraint(tp));
                    return new BoundErrorExpression(null);
                }
            }

            var typeArgs = ImmutableArray.CreateBuilder<TypeSymbol>(tps.Length);
            foreach (var tp in tps)
            {
                typeArgs.Add(substitution[tp]);
            }

            // Issue #1537: a generic nested type of a constructed generic
            // enclosing type (`Outer[int32].Middle[string]{…}`) threads BOTH the
            // enclosing arguments and its own arguments so member types
            // substitute both levels and the emitter encodes the reified nested
            // type (`Outer`1+Middle`2<int32, string>`).
            structSymbol = enclosingTypeArguments.IsDefaultOrEmpty
                ? StructSymbol.Construct(structSymbol, typeArgs.MoveToImmutable(), scope.References.MapClrTypeToReferences)
                : StructSymbol.ConstructNestedGeneric(structSymbol, enclosingTypeArguments, typeArgs.MoveToImmutable(), scope.References.MapClrTypeToReferences);
        }
        else if (syntax.TypeArgumentList != null)
        {
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, typeName, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(null);
        }
        else if (!enclosingTypeArguments.IsDefaultOrEmpty)
        {
            // Issue #1521: a NON-generic nested type of a constructed generic
            // enclosing type (`Box[int32].Tag{…}`) threads only the enclosing
            // arguments so member types typed as an enclosing parameter surface
            // closed and the emitter encodes `Box`1+Tag`1<int32>`.
            structSymbol = StructSymbol.ConstructNested(structSymbol, enclosingTypeArguments, scope.References.MapClrTypeToReferences);
        }

        var seenFieldNames = new HashSet<string>();
        var inits = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        List<(string Name, TypeSymbol MemberType, CollectionInitializerExpressionSyntax Braced, SyntaxToken Anchor)> bracedCollectionMembers = null;
        foreach (var initSyntax in syntax.Initializers)
        {
            var fieldName = initSyntax.FieldIdentifier.Text;

            // Issue #1211: a composite literal targets `var` fields AND settable
            // `prop` auto-properties (a property with a `set` or `init`
            // accessor). Resolve fields first, then fall back to properties so
            // both `class C { var X int32 }` and `class C { prop X int32 { get;
            // init; } }` accept `C{X: ...}`.
            var hasField = TypeMemberModel.TryGetFieldIncludingInherited(structSymbol, fieldName, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType);
            PropertySymbol property = null;
            StructSymbol propertyDeclaringType = null;
            if (!hasField)
            {
                if (!TypeMemberModel.TryGetProperty(structSymbol, fieldName, out property, out propertyDeclaringType))
                {
                    Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName);
                    continue;
                }
            }

            // Issue #2059: a composite/struct literal `Foo{ member: value }`
            // writes the member directly, bypassing normal assignment binding
            // — so it must enforce the SAME `private`/`protected` accessibility
            // rule as a qualified write (`receiver.field = value`, #2044/#2048).
            // This is independent of the get-only/init "is it writable at all"
            // check below; an inaccessible member is rejected here even when it
            // otherwise has a setter.
            if (!AccessibilityChecker.IsAccessible(
                hasField ? field.Accessibility : property.Accessibility,
                hasField ? fieldDeclaringType : propertyDeclaringType,
                this.function))
            {
                Diagnostics.ReportMemberInaccessible(
                    initSyntax.FieldIdentifier.Location,
                    fieldName,
                    (hasField ? fieldDeclaringType : propertyDeclaringType).Name,
                    hasField ? field.Accessibility : property.Accessibility);
            }

            // Issue #1567: a braced member value `Member: { a, b }` populates the
            // collection member by lowering to `.Add(...)` calls on the
            // constructed receiver's `Member` (the C# collection-initializer-in-
            // object-initializer pattern). It applies to get-only AND settable
            // collection members alike — C# always uses Add semantics for the
            // `= { … }` form — so it is handled before the get-only check. The
            // Add lowering is deferred until after the literal is constructed
            // (below), where a receiver to read `Member` from exists.
            if (initSyntax.Value is CollectionInitializerExpressionSyntax { Target: null } bracedMemberInit)
            {
                if (!seenFieldNames.Add(fieldName))
                {
                    Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                    continue;
                }

                bracedCollectionMembers ??= new List<(string, TypeSymbol, CollectionInitializerExpressionSyntax, SyntaxToken)>();
                bracedCollectionMembers.Add((fieldName, hasField ? field.Type : property.Type, bracedMemberInit, initSyntax.FieldIdentifier));
                continue;
            }

            // A get-only property (no `set` and no `init` accessor) cannot be
            // assigned in a composite literal — keep it diagnosed.
            if (!hasField && !property.HasSetter)
            {
                Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!seenFieldNames.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var memberType = hasField ? field.Type : property.Type;
            var valueExpr = BindExpression(initSyntax.Value);
            valueExpr = conversions.BindConversion(initSyntax.Value.Location, valueExpr, memberType);
            inits.Add(hasField
                ? new BoundFieldInitializer(field, valueExpr)
                : new BoundFieldInitializer(property, valueExpr));
        }

        // Issue #948: a value-type (struct / data struct) composite literal
        // zero-initializes the storage and then assigns the listed fields. For
        // a value type there is no constructor that could run inline field
        // initializers, so apply each declared `= expr` initializer here for any
        // field the literal omitted. (For class/data-class literals the
        // synthesized default constructor — invoked by `newobj` — already runs
        // the instance field initializers, so this only applies to value types.)
        // Issue #1714: also synthesize a `""` fallback for any `string` field
        // left uncovered by both the literal and a declared initializer —
        // `initobj` alone would leave it at the CLR default `null`, diverging
        // from the interpreter's Evaluator.DefaultValue (Go-style `""` zero
        // value for `string`).
        if (!structSymbol.IsClass)
        {
            foreach (var field in structSymbol.Fields)
            {
                if (seenFieldNames.Contains(field.Name))
                {
                    continue;
                }

                if (structSymbol.InstanceFieldInitializers.TryGetValue(field, out var initExpr))
                {
                    inits.Add(new BoundFieldInitializer(field, initExpr));
                    seenFieldNames.Add(field.Name);
                }
                else if (field.Type == TypeSymbol.String)
                {
                    // Issue #1714: this is a storage-default site (an omitted
                    // field in a struct literal), not the explicit `default`
                    // expression, so synthesize a plain `""` literal here
                    // rather than a BoundDefaultExpression — the latter now
                    // intentionally keeps CLR-null semantics for `string`.
                    inits.Add(new BoundFieldInitializer(field, new BoundLiteralExpression(null, string.Empty, TypeSymbol.String)));
                    seenFieldNames.Add(field.Name);
                }
            }
        }

        var structLiteral = new BoundStructLiteralExpression(null, structSymbol, inits.ToImmutable());
        if (bracedCollectionMembers == null)
        {
            return structLiteral;
        }

        // Issue #1567: one or more members were populated with a braced
        // collection initializer (`Member: { a, b }`). Construct the literal into
        // a synthetic local, then lower each such member to `.Add(...)` calls on
        // `local.Member`. Because the collection member is a reference type, the
        // Adds mutate the same collection the literal already holds, so yielding
        // the local returns the populated instance. Mirrors the imported-class
        // and standalone collection-initializer lowerings (block + temp local).
        var litTempName = "$implit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var litTemp = new LocalVariableSymbol(litTempName, isReadOnly: true, structSymbol);
        scope.TryDeclareVariable(litTemp);

        var bracedStatements = ImmutableArray.CreateBuilder<BoundStatement>();
        bracedStatements.Add(new BoundVariableDeclaration(syntax, litTemp, structLiteral));
        foreach (var (name, memberType, braced, anchor) in bracedCollectionMembers)
        {
            var litReceiver = new BoundVariableExpression(anchor, litTemp);
            if (!TryEmitMemberCollectionInitializer(litReceiver, name, anchor, braced, bracedStatements))
            {
                Diagnostics.ReportTypeNotCollectionInitializable(anchor.Location, memberType);
                BindCollectionElementsForDiagnostics(braced);
            }
        }

        var litResult = new BoundVariableExpression(syntax, litTemp);
        return new BoundBlockExpression(syntax, bracedStatements.ToImmutable(), litResult);
    }

    private BoundExpression BindStructuralSpreadLiteral(
        StructLiteralExpressionSyntax syntax,
        StructSymbol resolvedDefinition,
        ImmutableArray<TypeSymbol> enclosingTypeArguments)
    {
        var emptyTargetSyntax = new StructLiteralExpressionSyntax(
            syntax.SyntaxTree,
            syntax.TypeIdentifier,
            syntax.OpenBraceToken,
            spreadToken: null,
            spreadExpression: null,
            spreadSeparatorToken: null,
            new SeparatedSyntaxList<FieldInitializerSyntax>(ImmutableArray<SyntaxNode>.Empty),
            syntax.CloseBraceToken)
        {
            TypeArgumentList = syntax.TypeArgumentList,
        };

        var boundTarget = BindStructLiteralExpression(emptyTargetSyntax, resolvedDefinition, enclosingTypeArguments);
        var source = BindExpression(syntax.SpreadExpression);
        if (boundTarget is BoundErrorExpression)
        {
            foreach (var initializer in syntax.Initializers)
            {
                _ = BindExpression(initializer.Value);
            }

            return new BoundErrorExpression(syntax);
        }

        var explicitNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var initializer in syntax.Initializers)
        {
            explicitNames.Add(initializer.FieldIdentifier.Text);
        }

        if (!StructuralProjectionPlanner.TryCreate(
            source.Type,
            boundTarget.Type,
            strict: false,
            explicitNames,
            out var plan,
            out _))
        {
            var failedValues = new Dictionary<string, BoundExpression>(StringComparer.Ordinal);
            var failedOrder = ImmutableArray.CreateBuilder<string>(syntax.Initializers.Count);
            foreach (var initializer in syntax.Initializers)
            {
                failedValues[initializer.FieldIdentifier.Text] = BindExpression(initializer.Value);
                failedOrder.Add(initializer.FieldIdentifier.Text);
            }

            return conversions.BindStructuralProjection(
                syntax.SpreadExpression.Location,
                source,
                boundTarget.Type,
                strict: false,
                explicitValues: failedValues,
                explicitOrder: failedOrder.ToImmutable());
        }

        var slotTypes = new Dictionary<string, TypeSymbol>(StringComparer.Ordinal);
        foreach (var slot in plan.ConstructorSlots.Concat(plan.InitializerSlots))
        {
            slotTypes[slot.Name] = slot.TargetType;
        }

        var values = new Dictionary<string, BoundExpression>(StringComparer.Ordinal);
        var order = ImmutableArray.CreateBuilder<string>(syntax.Initializers.Count);
        foreach (var initializer in syntax.Initializers)
        {
            var name = initializer.FieldIdentifier.Text;
            if (values.ContainsKey(name))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initializer.FieldIdentifier.Location, name);
                _ = BindExpression(initializer.Value);
                continue;
            }

            if (!slotTypes.TryGetValue(name, out var slotType))
            {
                _ = BindExpression(initializer.Value);
                Diagnostics.ReportStructuralProjectionFailure(
                    initializer.FieldIdentifier.Location,
                    source.Type,
                    boundTarget.Type,
                    $"Explicit initializer '{name}' does not name a public construction or writable member slot.");
                continue;
            }

            if (initializer.Value is CollectionInitializerExpressionSyntax { Target: null } collection)
            {
                BindCollectionElementsForDiagnostics(collection);
                Diagnostics.ReportStructuralProjectionFailure(
                    initializer.FieldIdentifier.Location,
                    source.Type,
                    boundTarget.Type,
                    $"Explicit projection initializer '{name}' requires an expression value.");
                continue;
            }

            var value = BindExpression(initializer.Value);
            values.Add(name, conversions.BindConversion(initializer.Value.Location, value, slotType));
            order.Add(name);
        }

        return conversions.BindStructuralProjection(
            syntax.SpreadExpression.Location,
            source,
            boundTarget.Type,
            strict: false,
            explicitValues: values,
            explicitOrder: order.ToImmutable());
    }

    /// <summary>
    /// Issue #2258: dispatches a composite literal <c>T{Member: value, ...}</c>
    /// on an imported CLR type (resolved either by simple name through the
    /// import table, or by a fully-qualified namespace path via
    /// <see cref="TryBindQualifiedClrStructLiteral"/>) to the reference-type or
    /// value-type binder, mirroring the C# object-initializer contract for
    /// either kind.
    /// </summary>
    private BoundExpression BindImportedTypeLiteralExpression(StructLiteralExpressionSyntax syntax, Type clrType)
        => clrType.IsValueType
            ? BindImportedValueTypeLiteralExpression(syntax, clrType)
            : BindImportedClassLiteralExpression(syntax, clrType);

    /// <summary>
    /// Issue #1199: binds a composite literal <c>T{Member: value, ...}</c> on an
    /// IMPORTED reference-type class (e.g. <c>JsonSerializerOptions{WriteIndented:
    /// true}</c>). It lowers to the same shape as the object-initializer suffix
    /// (<c>T(){ Member = value }</c>, ADR-0117 / issue #569): construct the
    /// instance via its public parameterless constructor into a synthetic local,
    /// assign each named settable property/field through that local, and yield
    /// the local. Reusing existing bound nodes (<see
    /// cref="BoundClrConstructorCallExpression"/>,
    /// <see cref="BoundClrPropertyAssignmentExpression"/>) means emit and the
    /// interpreter both work without a new bound-node kind.
    /// </summary>
    private BoundExpression BindImportedClassLiteralExpression(StructLiteralExpressionSyntax syntax, Type clrType)
    {
        // The object-initializer lowering needs a constructed instance; require a
        // public parameterless constructor (the C# object-initializer contract).
        var parameterlessCtor = ClrTypeUtilities
            .SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(c => c.GetParameters().Length == 0);
        if (parameterlessCtor == null)
        {
            Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, syntax.TypeIdentifier.Text);
            foreach (var initSyntax in syntax.Initializers)
            {
                _ = BindExpression(initSyntax.Value);
            }

            return new BoundErrorExpression(null);
        }

        var resultType = TypeSymbol.FromClrType(clrType);
        BoundExpression construction = new BoundClrConstructorCallExpression(
            syntax,
            clrType,
            parameterlessCtor,
            ImmutableArray<BoundExpression>.Empty,
            resultType);

        return BindImportedTypeObjectInitializer(syntax, clrType, resultType, construction);
    }

    /// <summary>
    /// Issue #2258: binds a composite literal <c>T{Member: value, ...}</c> on an
    /// IMPORTED VALUE-TYPE struct (e.g.
    /// <c>System.Text.Json.JsonWriterOptions{ Indented: true }</c>). Unlike a
    /// reference type, reflection never synthesizes a public parameterless
    /// constructor for a plain value type (one only appears when the type
    /// explicitly declares a C# 10+ parameterless struct constructor), so the
    /// instance is seeded with its default/zero value (mirroring IL
    /// <c>initobj</c>) when no explicit parameterless constructor is found. The
    /// remaining member-assignment lowering is shared with the reference-type
    /// path; the value-type receiver is written in place through its local slot
    /// (see <c>EmitClrPropertyAssignment</c>'s addressable-receiver handling), so
    /// no copy-back step is needed.
    /// </summary>
    private BoundExpression BindImportedValueTypeLiteralExpression(StructLiteralExpressionSyntax syntax, Type clrType)
    {
        var resultType = TypeSymbol.FromClrType(clrType);
        var parameterlessCtor = ClrTypeUtilities
            .SafeGetConstructors(clrType, BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(c => c.GetParameters().Length == 0);
        BoundExpression construction = parameterlessCtor != null
            ? new BoundClrConstructorCallExpression(
                syntax,
                clrType,
                parameterlessCtor,
                ImmutableArray<BoundExpression>.Empty,
                resultType)
            : new BoundDefaultExpression(syntax, resultType);

        return BindImportedTypeObjectInitializer(syntax, clrType, resultType, construction);
    }

    /// <summary>
    /// Issue #1199 / #2258: shared object-initializer lowering for an imported
    /// CLR type composite literal — assigns each named settable property/field
    /// through a synthetic local seeded with <paramref name="construction"/>
    /// (a constructor call or a default-value expression), and yields the
    /// local. Shared by the reference-type and value-type literal binders.
    /// </summary>
    private BoundExpression BindImportedTypeObjectInitializer(StructLiteralExpressionSyntax syntax, Type clrType, TypeSymbol resultType, BoundExpression construction)
    {
        var tempName = "$implit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, resultType);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, construction));

        var seen = new HashSet<string>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var memberName = initSyntax.FieldIdentifier.Text;
            if (!seen.Add(memberName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName);
                continue;
            }

            // Resolve a public instance property (non-indexer) or field on the
            // imported CLR type. A settable member binds to a CLR property/field
            // assignment; a get-only/read-only member stays diagnosed (GS0127).
            MemberInfo member = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(clrType, memberName, BindingFlags.Public | BindingFlags.Instance);
            if (member is PropertyInfo idxProp && idxProp.GetIndexParameters().Length != 0)
            {
                member = null;
            }

            member ??= ClrTypeUtilities.SafeGetFieldIncludingInterfaces(clrType, memberName, BindingFlags.Public | BindingFlags.Instance);
            if (member == null)
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName);
                _ = BindExpression(initSyntax.Value);
                continue;
            }

            // Issue #1567: a braced member value `Member: { a, b }` populates the
            // (typically get-only) collection member by lowering to `.Add(...)`
            // calls on `receiver.Member` — the C# collection-initializer-in-
            // object-initializer pattern. This applies whether or not the member
            // is assignable (C# always uses Add semantics for the `= { … }`
            // form), so it is handled before the writability check.
            if (initSyntax.Value is CollectionInitializerExpressionSyntax { Target: null } bracedInit)
            {
                var bracedReceiver = new BoundVariableExpression(initSyntax, tempVar);
                if (!TryEmitMemberCollectionInitializer(bracedReceiver, memberName, initSyntax.FieldIdentifier, bracedInit, statements))
                {
                    var memberClrType = member is PropertyInfo bp ? bp.PropertyType : ((FieldInfo)member).FieldType;
                    Diagnostics.ReportTypeNotCollectionInitializable(initSyntax.FieldIdentifier.Location, TypeSymbol.FromClrType(memberClrType));
                    BindCollectionElementsForDiagnostics(bracedInit);
                }

                continue;
            }

            if (!TryGetWritableClrMember(member, out _, out var targetSymbol, out _))
            {
                Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName);
                _ = BindExpression(initSyntax.Value);
                continue;
            }

            var value = BindExpression(initSyntax.Value);
            var converted = conversions.BindConversion(initSyntax.Value.Location, value, targetSymbol);
            var receiverExpr = new BoundVariableExpression(initSyntax, tempVar);
            statements.Add(new BoundExpressionStatement(
                initSyntax,
                new BoundClrPropertyAssignmentExpression(initSyntax, receiverExpr, member, converted, targetSymbol)));
        }

        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    /// <summary>
    /// Issue #988 / #1235: binds a composite literal <c>T{Member: value, ...}</c>
    /// on a type parameter <paramref name="tp"/> constrained <c>where T : class,
    /// new()</c> (or <c>init()</c> in the G# spelling) — the generic-method
    /// counterpart of C#'s <c>new T { Member = value }</c>. Constructs <c>T</c>
    /// via the same reified <see cref="BoundTypeParameterConstructionExpression"/>
    /// that a bare <c>T()</c> call produces, then assigns each named member
    /// through the constraint's field/property surface (class constraint fields
    /// and properties, or a non-generic interface constraint's settable
    /// properties) — mirroring the assignment-side member resolution in
    /// <see cref="BindFieldAssignmentExpression"/>'s type-parameter branch. Shared
    /// by both binders so a variable receiver (<c>t.Member = v</c>) and an
    /// object-initializer literal (<c>T{Member: v}</c>) resolve members
    /// identically.
    /// </summary>
    private BoundExpression BindTypeParameterObjectInitializer(StructLiteralExpressionSyntax syntax, TypeParameterSymbol tp)
    {
        var tempName = "$implit" + System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var tempVar = new LocalVariableSymbol(tempName, isReadOnly: true, tp);
        scope.TryDeclareVariable(tempVar);

        var statements = ImmutableArray.CreateBuilder<BoundStatement>();
        statements.Add(new BoundVariableDeclaration(syntax, tempVar, new BoundTypeParameterConstructionExpression(syntax, tp)));

        var seen = new HashSet<string>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var memberName = initSyntax.FieldIdentifier.Text;
            if (!seen.Add(memberName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, memberName);
                _ = BindExpression(initSyntax.Value);
                continue;
            }

            var receiverExpr = new BoundVariableExpression(initSyntax, tempVar);

            if (tp.ClassConstraint is StructSymbol classConstraint)
            {
                if (TypeMemberModel.TryGetFieldIncludingInherited(classConstraint, memberName, MemberQuery.Instance(MemberKinds.Field), out var field, out var fieldDeclaringType))
                {
                    var fieldValue = BindExpression(initSyntax.Value);
                    var fieldConverted = conversions.BindConversion(initSyntax.Value.Location, fieldValue, field.Type);
                    statements.Add(new BoundExpressionStatement(
                        initSyntax,
                        BoundFieldAssignmentExpression.WithExpressionReceiver(initSyntax, receiverExpr, fieldDeclaringType, field, fieldConverted)));
                    continue;
                }

                if (TypeMemberModel.TryGetProperty(classConstraint, memberName, out var classProp, out var classPropDeclaringType))
                {
                    if (!classProp.HasSetter)
                    {
                        Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName);
                        _ = BindExpression(initSyntax.Value);
                        continue;
                    }

                    var classPropValue = BindExpression(initSyntax.Value);
                    var classPropConverted = conversions.BindConversion(initSyntax.Value.Location, classPropValue, classProp.Type);
                    statements.Add(new BoundExpressionStatement(
                        initSyntax,
                        new BoundPropertyAssignmentExpression(initSyntax, receiverExpr, classPropDeclaringType, classProp, classPropConverted)));
                    continue;
                }
            }

            if (tp.InterfaceConstraint is InterfaceSymbol interfaceConstraint
                && !interfaceConstraint.IsGenericDefinition
                && interfaceConstraint.TypeArguments.IsDefaultOrEmpty
                && TypeMemberModel.TryGetProperty(interfaceConstraint, memberName, out var ifaceProp, out _))
            {
                if (!ifaceProp.HasSetter)
                {
                    Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName);
                    _ = BindExpression(initSyntax.Value);
                    continue;
                }

                var ifacePropValue = BindExpression(initSyntax.Value);
                var ifacePropConverted = conversions.BindConversion(initSyntax.Value.Location, ifacePropValue, ifaceProp.Type);
                statements.Add(new BoundExpressionStatement(
                    initSyntax,
                    new BoundPropertyAssignmentExpression(initSyntax, receiverExpr, null, ifaceProp, ifacePropConverted)));
                continue;
            }

            if (tp.ClrInterfaceConstraint is TypeSymbol clrInterfaceConstraint
                && clrInterfaceConstraint.ClrType is Type clrInterface
                && clrInterface.IsInterface)
            {
                var clrProperty = ClrTypeUtilities.SafeGetPropertyIncludingInterfaces(
                    clrInterface,
                    memberName,
                    BindingFlags.Public | BindingFlags.Instance);
                if (clrProperty != null && clrProperty.GetIndexParameters().Length == 0)
                {
                    if (clrProperty.GetSetMethod(nonPublic: false) == null)
                    {
                        Diagnostics.ReportCannotAssign(initSyntax.FieldIdentifier.Location, memberName);
                        _ = BindExpression(initSyntax.Value);
                        continue;
                    }

                    var propertyType = MemberLookup.GetClrPropertyTypeSymbol(clrInterfaceConstraint, clrProperty);
                    var declaringInterface = MemberLookup.GetClrMemberDeclaringTypeSymbol(
                        clrInterfaceConstraint,
                        clrProperty);
                    var propertyValue = BindExpression(initSyntax.Value);
                    var converted = conversions.BindConversion(
                        initSyntax.Value.Location,
                        propertyValue,
                        propertyType);
                    statements.Add(new BoundExpressionStatement(
                        initSyntax,
                        new BoundClrPropertyAssignmentExpression(
                            initSyntax,
                            receiverExpr,
                            clrProperty,
                            converted,
                            propertyType,
                            tp,
                            declaringInterface)));
                    continue;
                }
            }

            Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, memberName);
            _ = BindExpression(initSyntax.Value);
        }

        var resultExpr = new BoundVariableExpression(syntax, tempVar);
        return new BoundBlockExpression(syntax, statements.ToImmutable(), resultExpr);
    }

    private BoundExpression BindTupleLiteralExpression(TupleLiteralExpressionSyntax syntax)
    {
        // Phase 4.5: bind each element expression, derive the tuple type from
        // their static types, and produce a BoundTupleLiteralExpression.
        var bound = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
        var elementTypes = ImmutableArray.CreateBuilder<TypeSymbol>(syntax.Elements.Count);
        foreach (var e in syntax.Elements)
        {
            var be = BindExpression(e);
            if (be.Type == TypeSymbol.Error)
            {
                return new BoundErrorExpression(null);
            }

            bound.Add(be);
            elementTypes.Add(be.Type);
        }

        var tupleType = TupleTypeSymbol.Get(elementTypes.MoveToImmutable());
        return new BoundTupleLiteralExpression(null, tupleType, bound.MoveToImmutable());
    }

    /// <summary>ADR-0039: Computes per-argument <see cref="RefKind"/> from CLR parameter metadata.</summary>
    /// <summary>
    /// Issue #368 / ADR-0055: rewrites any interpolated-string argument passed to
    /// a parameter typed as a user-defined <c>[InterpolatedStringHandler]</c> so
    /// that it carries the resolved handler-construction target. The referenced
    /// surrounding arguments / receiver named by
    /// <c>[InterpolatedStringHandlerArgument]</c> are captured and forwarded into
    /// the handler constructor by the emit lowerer. Arguments that are not
    /// handler-targeted interpolations are returned unchanged.
    /// </summary>
    /// <param name="parameters">The resolved method's/constructor's parameters.</param>
    /// <param name="arguments">The bound positional arguments (aligned with the leading parameters).</param>
    /// <param name="receiver">The instance receiver, or <see langword="null"/> for static/constructor calls.</param>
    /// <param name="location">The diagnostic location for the call.</param>
    /// <param name="parameterMapping">Issue #343: per-source-argument → parameter-position map; default for identity.</param>
    /// <returns>The arguments, with handler-targeted interpolations rewritten.</returns>
    private ImmutableArray<BoundExpression> ApplyInterpolatedStringHandlers(
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression receiver,
        TextLocation location,
        ImmutableArray<int> parameterMapping = default)
    {
        return ApplyInterpolatedStringHandlers(parameters, arguments, receiver, location, parameterMapping, out _, out _);
    }

    /// <summary>
    /// Issue #377 sub-items 1 + 2: extended overload that, in addition to
    /// rewriting handler-targeted interpolations, captures forwarded sibling
    /// arguments and the receiver into local temps so they are evaluated
    /// exactly once (matches C# §11.18.1). Returns the captured prelude
    /// statements through <paramref name="preludeStatements"/> and the
    /// (possibly substituted) receiver through <paramref name="updatedReceiver"/>.
    /// Callers wrap the produced call expression in a
    /// <see cref="BoundBlockExpression"/> when the prelude is non-empty.
    /// </summary>
    private ImmutableArray<BoundExpression> ApplyInterpolatedStringHandlers(
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<BoundExpression> arguments,
        BoundExpression receiver,
        TextLocation location,
        ImmutableArray<int> parameterMapping,
        out ImmutableArray<BoundStatement> preludeStatements,
        out BoundExpression updatedReceiver)
    {
        preludeStatements = ImmutableArray<BoundStatement>.Empty;
        updatedReceiver = receiver;

        if (parameters == null || arguments.IsDefaultOrEmpty)
        {
            return arguments;
        }

        ImmutableArray<BoundExpression>.Builder argBuilder = null;

        // Pass 1: build the handler info for each interpolated-string
        // argument that targets a [InterpolatedStringHandler] parameter.
        var handlerSlots = new System.Collections.Generic.List<(int ArgIndex, BoundInterpolatedStringExpression Interp, InterpolatedStringHandlerInfo Handler)>();
        for (var i = 0; i < arguments.Length; i++)
        {
            if (arguments[i] is not BoundInterpolatedStringExpression interp || interp.Handler != null)
            {
                continue;
            }

            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            if (paramIndex >= parameters.Length)
            {
                continue;
            }

            var parameterType = parameters[paramIndex].ParameterType;

            // Issue #377 sub-item 1: accept a by-ref handler-typed parameter
            // (e.g. `ref DefaultInterpolatedStringHandler`). Peel before
            // testing the attribute and let InterpolatedStringHandlerInfo
            // remember the RefKind so the lowerer can feed the constructed
            // handler local by-ref/in/out.
            var peeled = parameterType.IsByRef ? parameterType.GetElementType() : parameterType;
            if (!InterpolatedStringHandlerInfo.IsHandlerType(peeled))
            {
                continue;
            }

            var handler = InterpolatedStringHandlerInfo.TryCreate(
                peeled,
                parameters[paramIndex],
                parameters,
                arguments,
                receiver,
                out var failure);
            if (handler == null)
            {
                Diagnostics.ReportInterpolatedStringHandlerArgument(location, failure);
                continue;
            }

            handlerSlots.Add((i, interp, handler));
        }

        if (handlerSlots.Count == 0)
        {
            return arguments;
        }

        // Pass 2 (issue #377 sub-item 2): capture each forwarded source into
        // a shared local so the parent argument slot AND the handler
        // constructor reuse the same value. Side-effect-free expressions
        // (literals, locals, parameters) are not captured.
        argBuilder = arguments.ToBuilder();
        var preludeBuilder = ImmutableArray.CreateBuilder<BoundStatement>();
        var capturedReceiver = receiver;
        var receiverCaptured = false;

        // sourceIndex -> captured BoundVariableExpression. -1 represents the receiver.
        var captures = new System.Collections.Generic.Dictionary<int, BoundExpression>();

        foreach (var (_, _, handler) in handlerSlots)
        {
            for (var k = 0; k < handler.ForwardedSourceIndices.Length; k++)
            {
                var srcIndex = handler.ForwardedSourceIndices[k];
                if (srcIndex < 0)
                {
                    if (receiverCaptured)
                    {
                        continue;
                    }

                    if (receiver == null || IsSideEffectFreeForHandlerCapture(receiver))
                    {
                        receiverCaptured = true;
                        continue;
                    }

                    var (recvLocal, recvDecl) = CreateHandlerForwardCapture(receiver, "$handlerRecv", location);
                    preludeBuilder.Add(recvDecl);
                    capturedReceiver = recvLocal;
                    captures[-1] = recvLocal;
                    receiverCaptured = true;
                }
                else
                {
                    if (captures.ContainsKey(srcIndex))
                    {
                        continue;
                    }

                    var srcArg = argBuilder[srcIndex];
                    if (IsSideEffectFreeForHandlerCapture(srcArg))
                    {
                        continue;
                    }

                    var (local, decl) = CreateHandlerForwardCapture(srcArg, "$handlerArg" + srcIndex.ToString(System.Globalization.CultureInfo.InvariantCulture), location);
                    preludeBuilder.Add(decl);
                    argBuilder[srcIndex] = local;
                    captures[srcIndex] = local;
                }
            }
        }

        // Pass 3: rewrite each handler's forwarded args + parent arg slot
        // using either the captured locals (if any) or the originals.
        foreach (var slot in handlerSlots)
        {
            var (argIndex, interp, handler) = slot;
            var rewritten = ImmutableArray.CreateBuilder<BoundExpression>(handler.ForwardedArguments.Length);
            for (var k = 0; k < handler.ForwardedArguments.Length; k++)
            {
                var srcIndex = handler.ForwardedSourceIndices[k];
                if (captures.TryGetValue(srcIndex, out var captured))
                {
                    rewritten.Add(captured);
                }
                else
                {
                    rewritten.Add(handler.ForwardedArguments[k]);
                }
            }

            var newHandler = handler.WithForwardedArguments(rewritten.ToImmutable());
            argBuilder[argIndex] = interp.Update(interp.Parts, newHandler);
        }

        updatedReceiver = capturedReceiver;
        preludeStatements = preludeBuilder.ToImmutable();
        return argBuilder.ToImmutable();
    }

    /// <summary>
    /// Issue #377 sub-item 2: returns true for argument expressions that are
    /// safe to evaluate more than once (no observable side effect, no temp
    /// needed).
    /// </summary>
    private static bool IsSideEffectFreeForHandlerCapture(BoundExpression expression)
    {
        return expression switch
        {
            BoundLiteralExpression => true,
            BoundVariableExpression => true,
            _ => false,
        };
    }

    /// <summary>
    /// Issue #377 sub-item 2: creates a synthetic readonly local that
    /// captures <paramref name="value"/> and returns a load of that local.
    /// </summary>
    private (BoundExpression Load, BoundStatement Declaration) CreateHandlerForwardCapture(BoundExpression value, string namePrefix, TextLocation location)
    {
        var counter = System.Threading.Interlocked.Increment(ref binderCtx.SyntheticLocalCounter);
        var name = namePrefix + "_" + counter.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var local = new LocalVariableSymbol(name, isReadOnly: true, value.Type);
        scope.TryDeclareVariable(local);
        var decl = new BoundVariableDeclaration(value.Syntax, local, value);
        var load = new BoundVariableExpression(value.Syntax, local);
        return (load, decl);
    }

    /// <summary>
    /// Issue #377 sub-item 2: wraps a call expression with a
    /// <see cref="BoundBlockExpression"/> that evaluates the prelude
    /// statements (forwarded-arg temp captures) before the call. Returns
    /// <paramref name="call"/> unchanged when the prelude is empty.
    /// </summary>
    private static BoundExpression WrapWithHandlerPrelude(BoundExpression call, ImmutableArray<BoundStatement> prelude, SyntaxNode syntax)
    {
        if (prelude.IsDefaultOrEmpty)
        {
            return call;
        }

        return new BoundBlockExpression(syntax, prelude, call);
    }

    internal BoundExpression BindArrayCreationExpression(ArrayCreationExpressionSyntax syntax)
    {
        TypeSymbol elementType;
        if (syntax.HasNestedElementTypeClause)
        {
            // Issue #1046: jagged-array literal — the element is a nested type
            // clause (`[][]int32{ … }`), resolved recursively.
            elementType = bindTypeClause(syntax.ElementTypeClause);
            if (elementType == null)
            {
                return new BoundErrorExpression(null);
            }
        }
        else
        {
            elementType = lookupType(syntax.ElementTypeIdentifier.Text);
            if (elementType == null)
            {
                Diagnostics.ReportUndefinedType(syntax.ElementTypeIdentifier.Location, syntax.ElementTypeIdentifier.Text);
                return new BoundErrorExpression(null);
            }
        }

        var elements = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements?.Count ?? 0);

        // Issue #1272: the runtime/zero-initialised allocation form `[n]T`
        // (and the empty-initializer spelling `[n]T{}`). The length is an
        // arbitrary expression converted to int32 (mirroring how array indices
        // and `newarr` lengths are typed); the result is a zero-initialised
        // slice `[]T` of length `n` produced by the `newarr` emitter path.
        if (syntax.LengthExpression != null)
        {
            var boundLength = conversions.BindConversion(syntax.LengthExpression, TypeSymbol.Int32);
            return new BoundArrayCreationExpression(syntax, SliceTypeSymbol.Get(elementType), boundLength);
        }

        foreach (var elementSyntax in syntax.Elements)
        {
            elements.Add(conversions.BindConversion(elementSyntax, elementType));
        }

        if (syntax.LengthToken == null)
        {
            return new BoundArrayCreationExpression(null, SliceTypeSymbol.Get(elementType), elements.ToImmutable());
        }

        if (!int.TryParse(syntax.LengthToken.Text, out var length) || length < 0)
        {
            Diagnostics.ReportInvalidArrayLength(syntax.LengthToken.Location, syntax.LengthToken.Text);
            return new BoundErrorExpression(null);
        }

        if (syntax.Elements.Count != length)
        {
            Diagnostics.ReportArrayLiteralLengthMismatch(syntax.Location, length, syntax.Elements.Count);
        }

        return new BoundArrayCreationExpression(null, ArrayTypeSymbol.Get(elementType, length), elements.ToImmutable());
    }

    /// <summary>
    /// ADR-0124 / issues #1024, #1057, #1041: binds a stack-allocation
    /// expression in G#-style array grammar <c>stackalloc [n]T</c>. The default
    /// (safe) result is a <c>System.Span&lt;T&gt;</c> over the <c>localloc</c>'d
    /// memory and needs no <c>unsafe</c> context. When
    /// <paramref name="targetType"/> is an unmanaged pointer <c>*T</c> (only
    /// spellable inside an <c>unsafe</c> context, ADR-0122) whose pointee
    /// matches <c>T</c>, the raw <c>T*</c> pointer is produced instead. An
    /// optional initializer (<c>stackalloc [n]T{a, b, …}</c> or the
    /// count-inferred <c>stackalloc []T{a, b, …}</c>) supplies the element
    /// values; each must be convertible to <c>T</c> and the buffer length is
    /// the initializer length.
    /// </summary>
    /// <param name="syntax">The stackalloc syntax.</param>
    /// <param name="targetType">The contextual target type, or <see langword="null"/>.</param>
    /// <returns>The bound stackalloc expression.</returns>
    internal BoundExpression BindStackAllocExpression(StackAllocExpressionSyntax syntax, TypeSymbol targetType = null)
    {
        var elementType = lookupType(syntax.ElementTypeIdentifier.Text);
        if (elementType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.ElementTypeIdentifier.Location, syntax.ElementTypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        // The element type must be unmanaged/blittable: the buffer is raw,
        // contiguous, GC-untracked stack memory, so a managed reference (or a
        // type structurally containing one) cannot live in it.
        if (!TypeSymbol.IsLegalPointeeType(elementType) || elementType.ClrType == null)
        {
            Diagnostics.ReportStackAllocElementTypeNotBlittable(syntax.ElementTypeIdentifier.Location, elementType.Name);
            return new BoundErrorExpression(null);
        }

        // Issue #1041: bind the optional brace-delimited initializer. Each
        // element is converted to the element type T; the buffer length is the
        // number of initializer elements.
        var initializerElements = ImmutableArray<BoundExpression>.Empty;
        if (syntax.HasInitializer)
        {
            var builder = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
            foreach (var elementSyntax in syntax.Elements)
            {
                builder.Add(conversions.BindConversion(elementSyntax, elementType));
            }

            initializerElements = builder.ToImmutable();
        }

        BoundExpression count;
        if (syntax.IsCountInferred)
        {
            // Count-inferred `stackalloc []T{ … }`: the length comes from the
            // initializer. Without an initializer the length is undeterminable.
            if (!syntax.HasInitializer)
            {
                Diagnostics.ReportStackAllocCountInferredWithoutInitializer(syntax.Location);
                return new BoundErrorExpression(null);
            }

            count = new BoundLiteralExpression(null, initializerElements.Length, TypeSymbol.Int32);
        }
        else if (syntax.HasInitializer)
        {
            // Explicit count with an initializer: the two must agree, as in C#.
            var boundCount = conversions.BindConversion(syntax.CountExpression, TypeSymbol.Int32);
            if (TryGetConstantInt32(boundCount, out var explicitCount) && explicitCount != initializerElements.Length)
            {
                Diagnostics.ReportStackAllocInitializerLengthMismatch(syntax.Location, explicitCount, initializerElements.Length);
            }

            // The allocated buffer holds exactly the initializer elements.
            count = new BoundLiteralExpression(null, initializerElements.Length, TypeSymbol.Int32);
        }
        else
        {
            // Count-only `stackalloc [n]T`: a full (possibly runtime) expression.
            count = conversions.BindConversion(syntax.CountExpression, TypeSymbol.Int32);
        }

        // Unsafe pointer form: only when the declaration target is an unmanaged
        // pointer `*T`. A PointerTypeSymbol can only be produced inside an
        // unsafe context (ADR-0122), so the unsafe gating is intrinsic.
        if (targetType is PointerTypeSymbol)
        {
            var pointerType = PointerTypeSymbol.Get(elementType);
            return new BoundStackAllocExpression(syntax, pointerType, elementType, count, isPointerForm: true, initializerElements);
        }

        // Safe form: yield a Span<T> over the allocated memory.
        var spanType = TypeSymbol.FromClrType(typeof(System.Span<>).MakeGenericType(elementType.ClrType));
        return new BoundStackAllocExpression(syntax, spanType, elementType, count, isPointerForm: false, initializerElements);
    }

    private static bool TryGetConstantInt32(BoundExpression expression, out int value)
    {
        var current = expression;
        while (current is BoundConversionExpression conversion)
        {
            current = conversion.Expression;
        }

        if (current is BoundLiteralExpression { Value: int i })
        {
            value = i;
            return true;
        }

        value = 0;
        return false;
    }

    private BoundExpression BindMapCreationExpression(MapCreationExpressionSyntax syntax)
    {
        // ADR-0104: bind `map[K,V]{k1: v1, k2: v2, …}`.
        var mapType = bindTypeClause(syntax.TypeClause);
        if (mapType == null)
        {
            return new BoundErrorExpression(null);
        }

        if (mapType is not MapTypeSymbol mts)
        {
            // Defensive — the parser only produces a map type clause here.
            Diagnostics.ReportUndefinedType(syntax.TypeClause.Location, mapType.Name);
            return new BoundErrorExpression(null);
        }

        var entries = ImmutableArray.CreateBuilder<BoundMapEntry>(syntax.Entries.Count);
        foreach (var entrySyntax in syntax.Entries)
        {
            var key = conversions.BindConversion(entrySyntax.Key, mts.KeyType);
            var value = conversions.BindConversion(entrySyntax.Value, mts.ValueType);
            entries.Add(new BoundMapEntry(key, value));
        }

        return new BoundMapLiteralExpression(null, mts, entries.ToImmutable());
    }
}
