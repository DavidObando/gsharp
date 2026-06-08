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
        var typeSymbol = bindTypeClause(syntax.TypeClause);
        if (typeSymbol == null || typeSymbol == TypeSymbol.Error)
        {
            return new BoundErrorExpression(null);
        }

        var systemType = ImportedTypeSymbol.Get(typeof(Type));
        return new BoundTypeOfExpression(null, typeSymbol, systemType);
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
    /// <see cref="OverloadResolution.Resolve{T}(System.Collections.Generic.IEnumerable{T}, System.Collections.Generic.IReadOnlyList{System.Type}, System.Collections.Generic.IReadOnlyList{System.Type}, System.Func{System.Type, System.Type}, System.Collections.Generic.IReadOnlyList{bool}, System.Collections.Generic.IReadOnlyList{string})"/>,
    /// marking each positional argument whose syntax is an interpolated-string
    /// literal. These arguments may convert to an
    /// <c>IFormattable</c>/<c>FormattableString</c> parameter in addition to
    /// their natural <c>string</c> type. Returns <see langword="null"/> when no
    /// argument qualifies so callers pay nothing on the common path.
    /// </summary>
    private static IReadOnlyList<bool> ComputeInterpolatedStringArgFlags(SeparatedSyntaxList<ExpressionSyntax> argumentSyntax, int count)
    {
        bool[] flags = null;
        var limit = Math.Min(count, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            if (argumentSyntax[i] is InterpolatedStringExpressionSyntax)
            {
                flags ??= new bool[count];
                flags[i] = true;
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
    /// </summary>
    private ImmutableArray<BoundExpression> RebindFormattableInterpolationArguments(
        ImmutableArray<BoundExpression> arguments,
        SeparatedSyntaxList<ExpressionSyntax> argumentSyntax,
        System.Reflection.ParameterInfo[] parameters,
        ImmutableArray<int> parameterMapping = default)
    {
        ImmutableArray<BoundExpression>.Builder builder = null;
        var limit = Math.Min(arguments.Length, argumentSyntax.Count);
        for (var i = 0; i < limit; i++)
        {
            var paramIndex = parameterMapping.IsDefault ? i : parameterMapping[i];
            if (paramIndex >= parameters.Length)
            {
                continue;
            }

            var argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i]);
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

    private BoundExpression BindStructLiteralExpression(StructLiteralExpressionSyntax syntax)
    {
        var typeName = syntax.TypeIdentifier.Text;
        if (!scope.TryLookupTypeAlias(typeName, out var resolvedType) || !(resolvedType is StructSymbol structSymbol))
        {
            Diagnostics.ReportUnableToFindType(syntax.TypeIdentifier.Location, typeName);
            return new BoundErrorExpression(null);
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
                    if (!structSymbol.TryGetFieldIncludingInherited(initSyntax.FieldIdentifier.Text, out var field, out _))
                    {
                        continue;
                    }

                    var valueExpr = BindExpression(initSyntax.Value);
                    Binder.InferTypeArguments(field.Type, valueExpr.Type, substitution);
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

            structSymbol = StructSymbol.Construct(structSymbol, typeArgs.MoveToImmutable());
        }
        else if (syntax.TypeArgumentList != null)
        {
            Diagnostics.ReportWrongTypeArgumentCount(syntax.TypeArgumentList.Location, typeName, 0, syntax.TypeArgumentList.Arguments.Count);
            return new BoundErrorExpression(null);
        }

        var seenFieldNames = new HashSet<string>();
        var inits = ImmutableArray.CreateBuilder<BoundFieldInitializer>();
        foreach (var initSyntax in syntax.Initializers)
        {
            var fieldName = initSyntax.FieldIdentifier.Text;
            if (!structSymbol.TryGetFieldIncludingInherited(fieldName, out var field, out _))
            {
                Diagnostics.ReportUnableToFindMember(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            if (!seenFieldNames.Add(fieldName))
            {
                Diagnostics.ReportSymbolAlreadyDeclared(initSyntax.FieldIdentifier.Location, fieldName);
                continue;
            }

            var valueExpr = BindExpression(initSyntax.Value);
            valueExpr = conversions.BindConversion(initSyntax.Value.Location, valueExpr, field.Type);
            inits.Add(new BoundFieldInitializer(field, valueExpr));
        }

        return new BoundStructLiteralExpression(null, structSymbol, inits.ToImmutable());
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
        if (parameters == null || arguments.IsDefaultOrEmpty)
        {
            return arguments;
        }

        ImmutableArray<BoundExpression>.Builder builder = null;
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

            // V1 supports by-value handler parameters only; a by-ref handler
            // parameter (e.g. StringBuilder.Append(ref AppendInterpolatedStringHandler))
            // would require passing the handler local by address, which the call
            // sites here do not arrange.
            if (parameterType.IsByRef || !InterpolatedStringHandlerInfo.IsHandlerType(parameterType))
            {
                continue;
            }

            var handler = InterpolatedStringHandlerInfo.TryCreate(
                parameterType,
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

            builder ??= arguments.ToBuilder();
            builder[i] = interp.Update(interp.Parts, handler);
        }

        return builder?.ToImmutable() ?? arguments;
    }

    internal BoundExpression BindArrayCreationExpression(ArrayCreationExpressionSyntax syntax)
    {
        var elementType = lookupType(syntax.ElementTypeIdentifier.Text);
        if (elementType == null)
        {
            Diagnostics.ReportUndefinedType(syntax.ElementTypeIdentifier.Location, syntax.ElementTypeIdentifier.Text);
            return new BoundErrorExpression(null);
        }

        var elements = ImmutableArray.CreateBuilder<BoundExpression>(syntax.Elements.Count);
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

    private BoundExpression BindMapCreationExpression(MapCreationExpressionSyntax syntax)
    {
        // Phase 3.A.4: bind `map[K]V{k1: v1, k2: v2, …}`.
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
