// <copyright file="InterpolatedStringHandlerLowerer.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Lowering;

/// <summary>
/// Emit-time (IL-only) lowering of <see cref="BoundInterpolatedStringExpression"/>
/// to the C# 10 interpolated-string-handler pattern, or to composite formatting
/// when the target framework does not provide that handler (issues #368/#3769,
/// ADR-0055).
/// </summary>
/// <remarks>
/// When the target provides the default handler, each interpolation node is
/// rewritten into a <see cref="BoundBlockExpression"/> that does the following.
/// <list type="number">
/// <item>declares a <c>System.Runtime.CompilerServices.DefaultInterpolatedStringHandler</c>
/// value-type local and constructs it with <c>(literalLength, formattedCount)</c>.</item>
/// <item>calls <c>AppendLiteral(string)</c> for each literal run and
/// <c>AppendFormatted&lt;T&gt;(value[, alignment][, format])</c> for each hole.</item>
/// <item>yields <c>ToStringAndClear()</c> as the block's result.</item>
/// </list>
/// The handler is a <c>ref struct</c>; in metadata it is an ordinary value type
/// (the <c>IsByRefLike</c> marker does not affect the local signature), so the
/// existing value-type local / instance-call emit paths handle it directly.
/// <para>
/// Value-type holes do <b>not</b> box: <c>AppendFormatted&lt;T&gt;</c> is closed
/// over the hole's concrete CLR type (or, for user-defined types lacking a
/// reflection <see cref="System.Type"/>, over an <c>object</c> placeholder while
/// the real type-argument symbol is encoded into the emitted MethodSpec), so the
/// hole value is passed by its natural representation.
/// </para>
/// <para>
/// When the target does not provide the default handler, ordinary string
/// interpolation instead lowers to <c>String.Format(string, object[])</c>.
/// That target-compatible path boxes value-type holes and preserves composite
/// formatting, alignment, evaluation order, and literal-brace escaping.
/// User-defined interpolated-string handlers are unaffected.
/// </para>
/// This rewrite is applied only on the emit path; the tree-walk interpreter
/// renders <see cref="BoundInterpolatedStringExpression"/> directly.
/// </remarks>
internal sealed class InterpolatedStringHandlerLowerer : NestedFunctionBodyRewriter
{
    private readonly DiagnosticBag diagnostics = new();
    private readonly ReferenceResolver references;

    // Issue #3730/#3769: the DefaultInterpolatedStringHandler surface resolved
    // from the target reference closure. Null when the target does not declare
    // the required shape; ordinary string interpolation then uses String.Format.
    private readonly DefaultInterpolatedStringHandlerShape? handler;

    private int counter;
    private MethodInfo? stringFormat;

    private InterpolatedStringHandlerLowerer(ReferenceResolver references)
    {
        this.references = references;
        if (DefaultInterpolatedStringHandlerShape.TryResolve(references, out var shape, out _))
        {
            this.handler = shape;
        }
    }

    /// <summary>
    /// Produces a copy of <paramref name="program"/> in which every interpolated
    /// string has been lowered to the handler pattern. Returns the original
    /// instance unchanged when no interpolation is present.
    /// </summary>
    /// <param name="program">The bound program to lower.</param>
    /// <param name="references">
    /// The compilation's reference closure. Issue #3730: the handler surface the
    /// lowering targets is resolved from here, so it describes the framework
    /// being compiled against rather than the SDK hosting <c>gsc</c>.
    /// </param>
    /// <returns>The lowered program.</returns>
    public static BoundProgram Lower(BoundProgram program, ReferenceResolver references)
    {
        var lowerer = new InterpolatedStringHandlerLowerer(references);
        var changed = false;

        var functions = ImmutableDictionary.CreateBuilder<FunctionSymbol, BoundBlockStatement>();
        foreach (var pair in program.Functions)
        {
            var newBody = (BoundBlockStatement)lowerer.RewriteStatement(pair.Value);
            functions[pair.Key] = newBody;
            changed |= newBody != pair.Value;
        }

        var statement = (BoundBlockStatement)lowerer.RewriteStatement(program.Statement);
        changed |= statement != program.Statement;

        // Issue #975: base-constructor-initializer arguments (`: base(args)`) are
        // stored on the constructor / struct symbols rather than inside a method
        // body, so they bypass the function-body rewrite above. Lower any
        // interpolated strings sitting in that position too, otherwise the emitter
        // meets a raw BoundInterpolatedStringExpression and ICEs (GS9998). The
        // symbols are mutated in place; emission re-runs binding for each call, so
        // sharing across the discarded pre-lowering program is harmless.
        foreach (var structSym in program.Structs)
        {
            changed |= lowerer.RewriteBaseInitializers(structSym);
            changed |= lowerer.RewriteFieldInitializers(structSym);
        }

        foreach (var interfaceSym in program.Interfaces)
        {
            var initializers = interfaceSym.StaticFieldInitializers.ToBuilder();
            foreach (var pair in interfaceSym.StaticFieldInitializers)
            {
                var rewritten = lowerer.RewriteExpression(pair.Value);
                initializers[pair.Key] = rewritten;
                changed |= rewritten != pair.Value;
            }

            interfaceSym.SetStaticFieldInitializers(initializers.ToImmutable());
        }

        var diagnostics = program.Diagnostics.AddRange(lowerer.diagnostics.ToImmutableArray());
        if (!changed && diagnostics.Length == program.Diagnostics.Length)
        {
            return program;
        }

        var result = new BoundProgram(
            program.EntryPointPackage,
            program.Packages,
            diagnostics,
            functions.ToImmutable(),
            program.EntryPoint,
            statement,
            program.Structs,
            program.Interfaces,
            program.Enums,
            program.Globals,
            program.Delegates)
        {
            Imports = program.Imports,
            FriendAssemblies = program.FriendAssemblies,
            AssemblyAttributes = program.AssemblyAttributes,
            ModuleAttributes = program.ModuleAttributes,
        };

        return result;
    }

    /// <inheritdoc/>
    protected override BoundExpression RewriteInterpolatedStringExpression(BoundInterpolatedStringExpression node)
    {
        var literalLength = 0;
        var formattedCount = 0;
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                literalLength += Invariant.Required(part.Literal, "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null").Length;
            }
            else
            {
                formattedCount++;
            }
        }

        if (node.Handler != null)
        {
            return this.RewriteUserHandler(node, node.Handler, literalLength, formattedCount);
        }

        // Issue #3769: a handler supplied only by ReferenceResolver's host
        // fallback is not part of the target framework. Use the pre-C# 10
        // composite-format lowering instead of leaking System.Private.CoreLib
        // into the emitted assembly.
        if (this.handler == null)
        {
            return this.RewriteStringFormat(node);
        }

        foreach (var part in node.Parts)
        {
            if (part.IsHole &&
                TypeSymbol.IsByRefLike(part.Value.Type) &&
                FindByRefLikeToString(part.Value.Type) == null)
            {
                var location = part.HoleSyntax?.Location ?? part.Value.Syntax?.Location ?? node.Syntax?.Location ?? default;
                this.diagnostics.ReportByRefLikeInterpolationUnsupported(location, part.Value.Type);
            }
        }

        var (parts, leading) = this.PrepareParts(node);

        var handlerLocal = new LocalVariableSymbol($"<>interp{this.counter++}", isReadOnly: false, this.handler.HandlerTypeSymbol);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        // Issue #368: hole values that contain an await are pre-evaluated into
        // temporaries here, before the ByRefLike handler is constructed, so no
        // handler local is live across an await suspension.
        statements.AddRange(leading);

        var construct = new BoundClrConstructorCallExpression(
            node.Syntax,
            this.handler.HandlerType,
            this.handler.Constructor,
            ImmutableArray.Create<BoundExpression>(
                new BoundLiteralExpression(null, literalLength),
                new BoundLiteralExpression(null, formattedCount)),
            this.handler.HandlerTypeSymbol);
        statements.Add(new BoundVariableDeclaration(node.Syntax, handlerLocal, construct));

        foreach (var part in parts)
        {
            if (part.IsLiteral)
            {
                if (Invariant.Required(part.Literal, "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null").Length == 0)
                {
                    continue;
                }

                var append = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    new BoundVariableExpression(null, handlerLocal),
                    this.handler.AppendLiteral,
                    TypeSymbol.Void,
                    ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, part.Literal)));
                statements.Add(new BoundExpressionStatement(node.Syntax, append));
                continue;
            }

            var value = Invariant.Required(
                part.Value,
                "a formatted interpolated-string part has a bound value");
            var byRefLikeToString = TypeSymbol.IsByRefLike(value.Type) ? FindByRefLikeToString(value.Type) : null;
            if (byRefLikeToString != null)
            {
                value = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    value,
                    byRefLikeToString,
                    TypeSymbol.String,
                    ImmutableArray<BoundExpression>.Empty);
            }

            if (!this.TryCloseAppendFormatted(node, part, value.Type, out var method, out var typeArguments))
            {
                continue;
            }

            var arguments = ImmutableArray.CreateBuilder<BoundExpression>();
            arguments.Add(value);
            if (part.Alignment.HasValue)
            {
                arguments.Add(new BoundLiteralExpression(null, part.Alignment.Value));
            }

            if (part.Format != null)
            {
                arguments.Add(new BoundLiteralExpression(null, part.Format));
            }

            var appendFormatted = new BoundImportedInstanceCallExpression(
                node.Syntax,
                new BoundVariableExpression(null, handlerLocal),
                method,
                TypeSymbol.Void,
                arguments.ToImmutable(),
                argumentRefKinds: default,
                typeArgumentSymbols: ToNullableTypeArguments(typeArguments));
            statements.Add(new BoundExpressionStatement(node.Syntax, appendFormatted));
        }

        var result = new BoundImportedInstanceCallExpression(
            node.Syntax,
            new BoundVariableExpression(null, handlerLocal),
            this.handler.ToStringAndClear,
            TypeSymbol.String,
            ImmutableArray<BoundExpression>.Empty);

        return new BoundBlockExpression(node.Syntax, statements.ToImmutable(), result);
    }

    private BoundExpression RewriteStringFormat(BoundInterpolatedStringExpression node)
    {
        var (parts, leading) = this.PrepareParts(node);
        var format = new StringBuilder();
        var arguments = ImmutableArray.CreateBuilder<BoundExpression>();

        foreach (var part in parts)
        {
            if (part.IsLiteral)
            {
                AppendEscapedFormatLiteral(
                    format,
                    Invariant.Required(
                        part.Literal,
                        "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null"));
                continue;
            }

            var value = Invariant.Required(part.Value, "a formatted interpolated-string part has a bound value");
            if (TypeSymbol.IsByRefLike(value.Type))
            {
                var toString = FindByRefLikeToString(value.Type);
                if (toString == null)
                {
                    this.diagnostics.ReportByRefLikeInterpolationUnsupported(
                        part.HoleSyntax?.Location ?? value.Syntax?.Location ?? node.Syntax?.Location ?? default,
                        value.Type);
                    return node;
                }

                value = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    value,
                    toString,
                    TypeSymbol.String,
                    ImmutableArray<BoundExpression>.Empty);
            }

            var index = arguments.Count;
            arguments.Add(value.Type == TypeSymbol.Object
                ? value
                : new BoundConversionExpression(null, TypeSymbol.Object, value));

            format.Append('{').Append(index.ToString(CultureInfo.InvariantCulture));
            if (part.Alignment.HasValue)
            {
                format.Append(',').Append(part.Alignment.Value.ToString(CultureInfo.InvariantCulture));
            }

            if (part.Format != null)
            {
                format.Append(':').Append(part.Format);
            }

            format.Append('}');
        }

        var argumentArray = new BoundArrayCreationExpression(
            null,
            ArrayTypeSymbol.Get(TypeSymbol.Object, arguments.Count),
            arguments.ToImmutable());
        var result = new BoundClrStaticCallExpression(
            node.Syntax,
            this.GetStringFormatMethod(),
            TypeSymbol.String,
            ImmutableArray.Create<BoundExpression>(
                new BoundLiteralExpression(null, format.ToString()),
                argumentArray));

        return leading.IsEmpty
            ? result
            : new BoundBlockExpression(node.Syntax, leading, result);
    }

    private MethodInfo GetStringFormatMethod()
    {
        if (this.stringFormat != null)
        {
            return this.stringFormat;
        }

        if (!this.references.TryResolveType("System.String", requireExternalVisibility: false, out var stringType)
            || !this.references.TryResolveType("System.Object", requireExternalVisibility: false, out var objectType))
        {
            throw new InvalidOperationException("String.Format cannot be resolved from the target reference set.");
        }

        this.stringFormat = stringType.GetMethod(
            nameof(string.Format),
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: new[] { stringType, objectType.MakeArrayType() },
            modifiers: null)
            ?? throw new InvalidOperationException("String.Format(string, object[]) cannot be resolved from the target reference set.");
        return this.stringFormat;
    }

    private static void AppendEscapedFormatLiteral(StringBuilder builder, string text)
    {
        foreach (var character in text)
        {
            if (character is '{' or '}')
            {
                builder.Append(character);
            }

            builder.Append(character);
        }
    }

    /// <summary>
    /// Issue #975: rewrites the base-constructor-initializer argument lists held by
    /// the struct's primary constructor and every explicit constructor, lowering any
    /// interpolated strings (and other handled nodes) in <c>: base(args)</c> position
    /// the same way ordinary call arguments are lowered. Returns <see langword="true"/>
    /// when any initializer's arguments were rewritten.
    /// </summary>
    /// <param name="structSym">The class whose constructor base initializers to lower.</param>
    /// <returns><see langword="true"/> when at least one initializer changed.</returns>
    private bool RewriteBaseInitializers(StructSymbol structSym)
    {
        var changed = false;

        var primary = structSym.BaseConstructorInitializer;
        if (primary != null && this.TryRewriteInitializerArguments(primary, out var loweredPrimary))
        {
            structSym.SetBaseConstructorInitializer(loweredPrimary);
            changed = true;
        }

        foreach (var ctor in structSym.ExplicitConstructors)
        {
            var init = ctor.BaseInitializer;
            if (init != null && this.TryRewriteInitializerArguments(init, out var loweredInit))
            {
                ctor.SetBaseInitializer(loweredInit);
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>
    /// Lowers each argument of <paramref name="initializer"/>. When any argument is
    /// rewritten, produces a replacement initializer targeting the same base
    /// constructor and reports it via <paramref name="rewritten"/>.
    /// </summary>
    /// <param name="initializer">The base-constructor initializer to lower.</param>
    /// <param name="rewritten">The rewritten initializer when arguments changed; otherwise <see langword="null"/>.</param>
    /// <returns><see langword="true"/> when the arguments were rewritten.</returns>
    private bool TryRewriteInitializerArguments(BaseConstructorInitializer initializer, [NotNullWhen(true)] out BaseConstructorInitializer? rewritten)
    {
        rewritten = null;
        if (initializer.Arguments.IsDefaultOrEmpty)
        {
            return false;
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>(initializer.Arguments.Length);
        var changed = false;
        foreach (var argument in initializer.Arguments)
        {
            var loweredArgument = this.RewriteExpression(argument);
            changed |= loweredArgument != argument;
            builder.Add(loweredArgument);
        }

        if (!changed)
        {
            return false;
        }

        rewritten = initializer.WithArguments(builder.ToImmutable());
        return true;
    }

    /// <summary>
    /// Issue #368: when any interpolation hole contains an <c>await</c>, the hole
    /// values must be evaluated into temporaries <em>before</em> the (often
    /// ByRefLike) handler is constructed, so no handler local is live across an
    /// await suspension. Recursively lowers each hole value once, and — only when
    /// an await is present — emits leading <c>var tmp = value</c> declarations and
    /// rewrites the holes to read those temps. With no await present the parts are
    /// returned with their lowered values and no leading statements.
    /// </summary>
    /// <param name="node">The interpolated-string node being lowered.</param>
    /// <returns>The prepared parts and any leading temp declarations.</returns>
    private (ImmutableArray<BoundInterpolatedStringPart> Parts, ImmutableArray<BoundStatement> Leading) PrepareParts(BoundInterpolatedStringExpression node)
    {
        var lowered = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(node.Parts.Length);
        var anyAwait = false;
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                lowered.Add(part);
                continue;
            }

            var value = this.RewriteExpression(part.Value);
            anyAwait |= Async.AsyncBoundTreeQueries.HasAwait(value);
            lowered.Add(part.WithValue(value));
        }

        if (!anyAwait)
        {
            return (lowered.ToImmutable(), ImmutableArray<BoundStatement>.Empty);
        }

        var leading = ImmutableArray.CreateBuilder<BoundStatement>();
        var prepared = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(node.Parts.Length);
        foreach (var part in lowered)
        {
            if (part.IsLiteral)
            {
                prepared.Add(part);
                continue;
            }

            var tmp = new LocalVariableSymbol($"<>hole{this.counter++}", isReadOnly: false, part.Value.Type);
            leading.Add(new BoundVariableDeclaration(null, tmp, part.Value));
            prepared.Add(part.WithValue(new BoundVariableExpression(null, tmp)));
        }

        return (prepared.ToImmutable(), leading.ToImmutable());
    }

    /// <summary>
    /// Issue #418 (P1-9): for user handlers that require a per-append gate
    /// (<c>out bool shouldAppend</c> or bool-returning append methods), each
    /// hole expression must be evaluated lazily inside the gated block. This
    /// helper recursively lowers each hole value <em>without</em> pre-spilling
    /// to leading temps; awaiting holes are spilled into temps inside the gated
    /// block by <see cref="MakeAppendStatement"/>.
    /// </summary>
    private ImmutableArray<BoundInterpolatedStringPart> LowerHoleValuesInPlace(BoundInterpolatedStringExpression node)
    {
        var lowered = ImmutableArray.CreateBuilder<BoundInterpolatedStringPart>(node.Parts.Length);
        foreach (var part in node.Parts)
        {
            if (part.IsLiteral)
            {
                lowered.Add(part);
                continue;
            }

            lowered.Add(part.WithValue(this.RewriteExpression(part.Value)));
        }

        return lowered.ToImmutable();
    }

    /// <summary>
    /// Issue #368: lowers an interpolated string targeting a user-defined
    /// <c>[InterpolatedStringHandler]</c> parameter. Constructs the handler with
    /// <c>(literalLength, formattedCount, ...forwarded args [, out bool shouldAppend])</c>,
    /// appends each part, and yields the constructed handler value itself (not
    /// <c>ToStringAndClear()</c>) so the receiving API consumes the handler.
    /// </summary>
    private BoundExpression RewriteUserHandler(
        BoundInterpolatedStringExpression node,
        InterpolatedStringHandlerInfo info,
        int literalLength,
        int formattedCount)
    {
        var handlerClrType = info.HandlerClrType;
        var handlerSymbol = info.HandlerType;

        var handlerLocal = new LocalVariableSymbol($"<>interp{this.counter++}", isReadOnly: false, handlerSymbol);
        var statements = ImmutableArray.CreateBuilder<BoundStatement>();

        var appendLiteral = FindAppendLiteral(handlerClrType);

        // Issue #418 (P1-9): when the handler ctor produces an `out bool shouldAppend`
        // or some append method returns `bool`, every per-append call (including
        // evaluation of the hole expression) must be gated behind that running
        // condition. The spec requires lazy evaluation of holes — setting
        // shouldAppend = false in the ctor must skip both the AppendFormatted call
        // and the side effects of the hole expression itself (e.g. an `await`).
        var appendsReturnBool = AppendsReturnBool(handlerClrType, appendLiteral);
        var needsGate = info.HasTrailingOutBool || appendsReturnBool;

        // When gating is needed we cannot pre-spill holes into leading temps
        // because that evaluates them before the ctor decides shouldAppend.
        // Instead, recursively lower the hole values in place and defer any
        // await-spill into the gated block (see MakeAppendStatement). Without
        // gating, the existing PrepareParts pre-spill preserves ref-struct
        // safety across awaits.
        ImmutableArray<BoundInterpolatedStringPart> parts;
        if (needsGate)
        {
            parts = this.LowerHoleValuesInPlace(node);
        }
        else
        {
            ImmutableArray<BoundStatement> leading;
            (parts, leading) = this.PrepareParts(node);
            statements.AddRange(leading);
        }

        // Build the constructor argument list: (literalLength, formattedCount,
        // ...forwarded args [, &shouldAppend]).
        var ctorArgs = ImmutableArray.CreateBuilder<BoundExpression>();
        ctorArgs.Add(new BoundLiteralExpression(null, literalLength));
        ctorArgs.Add(new BoundLiteralExpression(null, formattedCount));
        foreach (var forwarded in info.ForwardedArguments)
        {
            ctorArgs.Add(this.RewriteExpression(forwarded));
        }

        LocalVariableSymbol? shouldAppendLocal = null;
        ImmutableArray<RefKind> ctorRefKinds = default;
        if (info.HasTrailingOutBool)
        {
            shouldAppendLocal = new LocalVariableSymbol($"<>shouldAppend{this.counter++}", isReadOnly: false, TypeSymbol.Bool);
            statements.Add(new BoundVariableDeclaration(null, shouldAppendLocal, new BoundLiteralExpression(null, false)));
            ctorArgs.Add(new BoundAddressOfExpression(null, new BoundVariableExpression(null, shouldAppendLocal)));

            var refKinds = ImmutableArray.CreateBuilder<RefKind>(ctorArgs.Count);
            for (var i = 0; i < ctorArgs.Count - 1; i++)
            {
                refKinds.Add(RefKind.None);
            }

            refKinds.Add(RefKind.Out);
            ctorRefKinds = refKinds.MoveToImmutable();
        }

        var construct = new BoundClrConstructorCallExpression(
            node.Syntax,
            handlerClrType,
            info.Constructor,
            ctorArgs.ToImmutable(),
            handlerSymbol,
            ctorRefKinds);
        statements.Add(new BoundVariableDeclaration(node.Syntax, handlerLocal, construct));

        LocalVariableSymbol? continueLocal = null;
        if (needsGate)
        {
            continueLocal = new LocalVariableSymbol($"<>cont{this.counter++}", isReadOnly: false, TypeSymbol.Bool);
            BoundExpression seed = shouldAppendLocal != null
                ? new BoundVariableExpression(null, shouldAppendLocal)
                : new BoundLiteralExpression(null, true);
            statements.Add(new BoundVariableDeclaration(null, continueLocal, seed));
        }

        foreach (var part in parts)
        {
            BoundExpression appendCall;
            if (part.IsLiteral)
            {
                if (Invariant.Required(part.Literal, "a literal part is created by BoundInterpolatedStringPart.FromLiteral, which stores string.Empty rather than null").Length == 0)
                {
                    continue;
                }

                appendCall = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    new BoundVariableExpression(null, handlerLocal),
                    appendLiteral,
                    TypeSymbol.FromClrType(appendLiteral.ReturnType),
                    ImmutableArray.Create<BoundExpression>(new BoundLiteralExpression(null, part.Literal)));
            }
            else
            {
                var value = part.Value;

                // Issue #418: when gating, an await inside the hole must not run
                // before the gate is checked. Defer the spill into the gated block
                // so the temp is initialized only when the gate allows the append.
                ImmutableArray<BoundStatement> holeLeading = ImmutableArray<BoundStatement>.Empty;
                if (needsGate && Async.AsyncBoundTreeQueries.HasAwait(value))
                {
                    var holeTmp = new LocalVariableSymbol($"<>hole{this.counter++}", isReadOnly: false, value.Type);
                    holeLeading = ImmutableArray.Create<BoundStatement>(
                        new BoundVariableDeclaration(null, holeTmp, value));
                    value = new BoundVariableExpression(null, holeTmp);
                }

                if (!InterpolatedStringHandlerInfo.TryResolveAppendFormatted(
                    handlerClrType,
                    part,
                    value.Type,
                    out var method,
                    out var typeArguments))
                {
                    throw new System.InvalidOperationException(
                        $"Interpolated-string handler '{handlerClrType.Name}' was lowered without a compatible AppendFormatted method.");
                }

                var arguments = ImmutableArray.CreateBuilder<BoundExpression>();
                arguments.Add(value);
                if (part.Alignment.HasValue)
                {
                    arguments.Add(new BoundLiteralExpression(null, part.Alignment.Value));
                }

                if (part.Format != null)
                {
                    arguments.Add(new BoundLiteralExpression(null, part.Format));
                }

                appendCall = new BoundImportedInstanceCallExpression(
                    node.Syntax,
                    new BoundVariableExpression(null, handlerLocal),
                    method,
                    TypeSymbol.FromClrType(method.ReturnType),
                    arguments.ToImmutable(),
                    argumentRefKinds: default,
                    typeArgumentSymbols: ToNullableTypeArguments(typeArguments));

                statements.Add(this.MakeAppendStatement(node.Syntax, appendCall, continueLocal, holeLeading));
                continue;
            }

            statements.Add(this.MakeAppendStatement(node.Syntax, appendCall, continueLocal));
        }

        var resultValue = new BoundVariableExpression(null, handlerLocal);

        // Issue #377 sub-item 1: a byref handler-typed parameter consumes
        // the address of the constructed handler local. Wrap the trailing
        // value with an address-of so EmitBlockExpression emits `ldloca` for
        // the by-ref / in / out slot. (The emitter falls back to the block
        // expression itself for byref slots and re-emits its trailing
        // expression directly.)
        BoundExpression trailing = resultValue;
        if (info.HandlerRefKind != RefKind.None)
        {
            trailing = new BoundAddressOfExpression(node.Syntax, resultValue);
        }

        return new BoundBlockExpression(node.Syntax, statements.ToImmutable(), trailing);
    }

    /// <summary>
    /// Wraps a single append call so it runs only while the short-circuit
    /// condition (<paramref name="continueLocal"/>) is still <c>true</c>. When
    /// the append returns <c>bool</c> its result updates the condition. When no
    /// gating is required the call is emitted unconditionally.
    /// <para>
    /// Issue #418 (P1-9): any <paramref name="holeLeading"/> statements
    /// (hole-evaluation spills produced for awaiting holes when gating is in
    /// effect) are emitted <em>inside</em> the gated block so the hole
    /// expression is evaluated only when the gate allows the append.
    /// </para>
    /// </summary>
    private BoundStatement MakeAppendStatement(
        SyntaxNode? syntax,
        BoundExpression appendCall,
        LocalVariableSymbol? continueLocal,
        ImmutableArray<BoundStatement> holeLeading = default)
    {
        var returnsBool = appendCall.Type?.ClrType.IsSameAs(typeof(bool)) == true;
        var leading = holeLeading.IsDefault ? ImmutableArray<BoundStatement>.Empty : holeLeading;

        if (continueLocal == null)
        {
            if (leading.IsEmpty)
            {
                return new BoundExpressionStatement(syntax, appendCall);
            }

            var unguarded = ImmutableArray.CreateBuilder<BoundStatement>(leading.Length + 1);
            unguarded.AddRange(leading);
            unguarded.Add(new BoundExpressionStatement(syntax, appendCall));
            return new BoundBlockStatement(syntax, unguarded.ToImmutable());
        }

        BoundStatement inner = returnsBool
            ? new BoundExpressionStatement(syntax, new BoundAssignmentExpression(null, continueLocal, appendCall))
            : new BoundExpressionStatement(syntax, appendCall);

        // Emit already-flattened control flow (conditional goto + label) because
        // this lowering pass runs after the binder's if->goto rewrite, so a
        // BoundIfStatement introduced here would never be lowered for emit:
        //
        //   gotoFalse <>cont end
        //   [hole-leading spills (issue #418)]
        //   <append (maybe assigns <>cont)>
        //   end:
        var endLabel = new BoundLabel($"<>appendEnd{this.counter++}");
        var gotoFalse = new BoundConditionalGotoStatement(
            null,
            endLabel,
            new BoundVariableExpression(null, continueLocal),
            jumpIfTrue: false);
        var endLabelStatement = new BoundLabelStatement(null, endLabel);

        var block = ImmutableArray.CreateBuilder<BoundStatement>(2 + leading.Length + 1);
        block.Add(gotoFalse);
        block.AddRange(leading);
        block.Add(inner);
        block.Add(endLabelStatement);
        return new BoundBlockStatement(syntax, block.ToImmutable());
    }

    private bool RewriteFieldInitializers(StructSymbol structSym)
    {
        var changed = false;
        var staticInitializers = structSym.StaticFieldInitializers.ToBuilder();
        foreach (var pair in structSym.StaticFieldInitializers)
        {
            var rewritten = this.RewriteExpression(pair.Value);
            staticInitializers[pair.Key] = rewritten;
            changed |= rewritten != pair.Value;
        }

        structSym.SetStaticFieldInitializers(staticInitializers.ToImmutable());

        var instanceInitializers = structSym.InstanceFieldInitializers.ToBuilder();
        foreach (var pair in structSym.InstanceFieldInitializers)
        {
            var rewritten = this.RewriteExpression(pair.Value);
            instanceInitializers[pair.Key] = rewritten;
            changed |= rewritten != pair.Value;
        }

        structSym.SetInstanceFieldInitializers(instanceInitializers.ToImmutable());
        return changed;
    }

    private static MethodInfo FindAppendLiteral(System.Type handlerType)
        => InterpolatedStringHandlerInfo.TryResolveAppendLiteral(handlerType, out var method)
            ? method
            : throw new System.InvalidOperationException(
                $"Interpolated-string handler '{handlerType.Name}' has no AppendLiteral(string) method.");

    private static bool AppendsReturnBool(System.Type handlerType, MethodInfo appendLiteral)
    {
        if (appendLiteral.ReturnType.IsSameAs(typeof(bool)))
        {
            return true;
        }

        foreach (var method in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (method.Name == "AppendFormatted" && method.ReturnType.IsSameAs(typeof(bool)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #3730: picks the <c>AppendFormatted&lt;T&gt;</c> overload the hole's
    /// decorations need <em>from the target framework's handler</em> and closes it
    /// over the hole's CLR type. Returns <see langword="false"/> — having reported
    /// GS0545 — when the target does not declare that overload, rather than
    /// emitting a call the target's runtime cannot resolve.
    /// </summary>
    /// <param name="node">The interpolation being lowered, for diagnostic anchoring.</param>
    /// <param name="part">The hole whose alignment/format decorations select the overload.</param>
    /// <param name="holeType">The hole's type.</param>
    /// <param name="method">The closed <c>AppendFormatted</c>.</param>
    /// <param name="typeArguments">The symbolic type arguments the emitter must encode, when the hole has no reflection type.</param>
    /// <returns><see langword="true"/> when an overload was available.</returns>
    private bool TryCloseAppendFormatted(
        BoundInterpolatedStringExpression node,
        BoundInterpolatedStringPart part,
        TypeSymbol holeType,
        [NotNullWhen(true)] out MethodInfo? method,
        out ImmutableArray<TypeSymbol> typeArguments)
    {
        var shape = Invariant.Required(this.handler, "the handler shape is resolved before any part is lowered");
        var (open, signature) = shape.GetAppendFormatted(part.Alignment.HasValue, part.Format != null);
        if (open == null)
        {
            method = null;
            typeArguments = default;
            this.diagnostics.ReportInterpolatedStringHandlerUnavailable(
                part.HoleSyntax?.Location ?? part.Value?.Syntax?.Location ?? node.Syntax?.Location ?? default,
                signature);
            return false;
        }

        // Issue #1916: a `T?` hole over a value type must close over
        // `Nullable<T>`, not the bare `TypeSymbol.ClrType` (which is the
        // underlying `T` per NullableTypeSymbol's ctor) — the value pushed on
        // the stack for a nullable-typed local/expression is the full
        // `Nullable<T>` struct, so closing the generic method over `T` leaves
        // a StackUnexpected mismatch at the call site (found Nullable<T>,
        // expected T). GetEffectiveClrType returns `Nullable<T>` for
        // value-type nullables and `holeType.ClrType` for everything else.
        var clrType = NullableTypeSymbol.GetEffectiveClrType(holeType);
        if (clrType != null)
        {
            // Primitive / BCL / reference holes close over their concrete CLR
            // type, so a value-type hole is passed without boxing.
            method = shape.CloseAppendFormatted(open, clrType);
            typeArguments = default;
            return true;
        }

        // A user-defined type has no reflection Type; close over an object
        // placeholder and carry the real type-argument symbol so the emitter
        // encodes the user TypeDef into the MethodSpec (issue #320 path).
        method = shape.CloseAppendFormatted(open, typeof(object));
        typeArguments = ImmutableArray.Create(holeType);
        return true;
    }

    private static MethodInfo? FindByRefLikeToString(TypeSymbol type)
        => type?.ClrType?.GetMethodSafe("ToString", System.Type.EmptyTypes);

    private static ImmutableArray<TypeSymbol?> ToNullableTypeArguments(ImmutableArray<TypeSymbol> typeArguments)
        => typeArguments.IsDefault
            ? default
            : typeArguments.Select(static typeArgument => (TypeSymbol?)typeArgument).ToImmutableArray();
}
